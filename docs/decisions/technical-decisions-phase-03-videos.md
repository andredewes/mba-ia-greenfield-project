---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-27
scope_description: "Fundação de backend para upload e processamento de vídeos grandes: acesso ao object storage, estratégia de upload de 10GB, fila de processamento em segundo plano, modelo de execução do worker, extração de metadados/thumbnail com FFmpeg, identificador de URL pública única, streaming por range, download e ciclo de status do vídeo."
---

# Decisões Técnicas — Fase 03: Upload e Processamento de Vídeos

_Subprojetos no escopo:_

- `nestjs-project/` — backend que entrega o módulo de vídeos (entidade, endpoints de início/conclusão de upload, streaming, download), a integração com object storage (MinIO/S3), a fila de processamento (lado produtor) e o worker de vídeo independente (lado consumidor, FFmpeg).
- `next-frontend/` — Fora do escopo desta fase. A UI de vídeo (tela de upload, página do player) é entregue em fases posteriores (Fase 04/05). Nenhuma decisão em aberto neste documento.

_Nova infraestrutura introduzida por esta fase (toda via Docker Compose):_ object storage (MinIO), um broker de fila (Redis) e um container separado de video-worker com FFmpeg.

---

## TD-01: Cliente de Object Storage e Organização de Buckets/Chaves

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O backend de armazenamento em si **não** é uma escolha em aberto — a arquitetura do projeto (`docs/diagrams/software-arch.mermaid`, `CLAUDE.md` na raiz) já determina **object storage compatível com S3**, executado localmente como **MinIO** no Docker e substituível por AWS S3 em produção. O que este TD decide é *como* o backend conversa com ele (qual biblioteca cliente) e *como os objetos são organizados* (buckets e nomenclatura de chaves), já que esse contrato é compartilhado pela API (presign, streaming, download), pelo worker (lê o original, grava o thumbnail) e pela migration/entidade (chaves armazenadas).

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- SDK modular oficial da AWS. O mesmo código funciona contra MinIO (`endpoint` customizado, `forcePathStyle: true`) e contra o S3 real (basta remover o endpoint). Presign via o pacote dedicado `s3-request-presigner`; streaming via `GetObjectCommand` com um `Range`.
- **Prós:** Canônico, oficial e ativamente mantido. `forcePathStyle` + `endpoint` customizado é a receita documentada para MinIO — zero divergência entre dev (MinIO) e produção (S3). Pacotes modulares e tree-shakeable. Suporte nativo a presigned URL e multipart upload (necessário para o TD-02). Tipos TypeScript já incluídos.
- **Contras:** Grafo de dependências transitivas grande (o cliente S3 puxa vários pacotes `@aws-sdk/*` e `@smithy/*`). API verbosa (objetos de comando).

### Option B: Cliente JS do MinIO (`minio`)
- SDK próprio do MinIO. Ergonomia mais simples especificamente para MinIO.
- **Prós:** Superfície menor, nomes de método simples (`presignedPutObject`, `getPartialObject`).
- **Contras:** Acopla o código ao cliente MinIO mesmo que a produção mire um S3 genérico. A ergonomia de multipart/presigned-POST está menos alinhada com a semântica do S3. A arquitetura enquadra explicitamente o storage como "S3 (compatível)" — usar o SDK neutro da AWS mantém a troca para produção como mudança de configuração, não de código.

**Recommendation:** **Option A (AWS SDK v3)** — A intenção declarada na arquitetura é "compatível com S3, MinIO localmente, S3 em produção". O AWS SDK v3 torna essa troca uma mudança puramente de configuração (`endpoint` + `forcePathStyle`), que é exatamente a propriedade cross-component desejada. É a única opção com suporte de primeira classe a presigned multipart, do qual o TD-02 depende. O grafo de dependências mais pesado é um custo único e aceito.

**Organização de buckets/chaves (decidido):** um único bucket (padrão `streamtube-videos`, configurável via env) com chaves determinísticas escopadas pelo id do vídeo:
- Upload original: `videos/{videoId}/original` (o objeto bruto enviado).
- Thumbnail gerado: `thumbnails/{videoId}/thumb.jpg`.

Justificativa: prefixos escopados por id garantem que não haja colisão de chave entre vídeos, tornam a limpeza por vídeo um único delete de prefixo e mantêm as colunas da entidade (`storage_key`, `thumbnail_key`) opacas e estáveis. O identificador público **não** é a chave de storage (ver TD-06) — chaves de storage nunca vazam para os clientes.

**Decision:** A (AWS SDK v3, bucket único, chaves escopadas por id)

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

---

## TD-02: Estratégia de Upload de Arquivos Grandes (10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Um upload de 10GB não pode passar pelo processo da API NestJS — bufferizar ou mesmo fazer streaming de 10GB pelo event loop do Node trava memória/CPU e bloqueia a API (a "reprova automática" explícita do enunciado). A decisão é o handshake pelo qual o cliente coloca os bytes no object storage sem a API repassar o conteúdo.

**Options:**

### Option A: Presigned URLs — upload direto ao storage (PUT único para pequenos, multipart para grandes)
- A API emite presigned URLs de curta duração; o cliente envia os bytes **diretamente ao MinIO/S3**. Para 10GB, o limite rígido de 5GB do PUT único do S3 força o **multipart upload**: a API chama `CreateMultipartUpload`, faz o presign de cada URL de `UploadPart`, o cliente envia cada parte por PUT direto ao storage e então a API faz `CompleteMultipartUpload`. A API nunca toca no payload.
- **Prós:** Os 10GB nunca entram no processo da API — memória constante da API independentemente do tamanho do arquivo. Multipart permite paralelismo e **retomada** (reenviar apenas uma parte que falhou, atendendo ao "retomar em caso de falha" do plano). Padrão S3 conhecido e documentado. Funciona de forma idêntica em MinIO e S3.
- **Contras:** Mais endpoints e um handshake de várias etapas (iniciar → presign das partes → concluir). O cliente precisa orquestrar o upload das partes. A expiração da presigned URL precisa ser calibrada para uploads lentos de 10GB.

### Option B: Streaming pela API (busboy / `PutObject` por stream)
- O cliente envia para a API, que canaliza o stream da requisição direto para o `PutObject`.
- **Prós:** Endpoint único; o cliente só faz POST de um arquivo. A API pode aplicar auth/validação inline.
- **Contras:** Cada byte ainda atravessa o processo da API e seu salto de rede duas vezes (cliente→API→storage). 10GB prendem uma conexão/worker da API durante toda a transferência; uploads concorrentes esgotam a API. Sem retomada nativa. É exatamente o anti-padrão de "passar o arquivo pela API" que o enunciado proíbe.

### Option C: Protocolo de upload resumível tus (`@tus/server`)
- Protocolo de upload resumível com um servidor tus (na API ou em sidecar) gravando no storage.
- **Prós:** Melhor retomada da categoria e UX de pausar/retomar; chunked.
- **Contras:** Introduz um protocolo + componente de servidor inteiros e um cliente compatível com tus. Com o servidor tus in-process, os bytes ainda fluem pela API a menos que pareado com um backend de storage; o peso operacional é alto para esta fase. O multipart presigned já entrega o requisito não funcional central (a API nunca repassa bytes) com muito menos superfície nova.

**Recommendation:** **Option A (multipart presigned, direto ao storage)** — É a única opção que satisfaz a restrição rígida (10GB não pode fluir pela API) enquanto reutiliza o storage que já rodamos, e dá retomada por parte de graça. O tus (C) resolve o mesmo problema com muito mais maquinário; o streaming (B) viola a restrição. A complexidade do handshake fica contida em um pequeno conjunto de endpoints (o TD-10 cobre a outra metade, de gatilho de conclusão).

**Decision:** A (Upload multipart presigned, direto ao storage)

**Libraries:** (coberto pelo TD-01 — nenhuma biblioteca adicional)

---

## TD-03: Tecnologia da Fila de Processamento em Segundo Plano

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O processamento de vídeo (extração de metadados, geração de thumbnail) é pesado e precisa rodar fora do caminho da requisição, em um worker separado, com retentativas e visibilidade de falhas. O plano do projeto deixa a tecnologia de fila explicitamente como **"TBD"** — esta é a decisão de stack mais importante da fase. O payload do job é pequeno (um id de vídeo); o trabalho é pesado em CPU/IO e vive no worker (TD-04).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq` + `bullmq`)
- Fila de jobs baseada em Redis com integração de primeira classe ao NestJS. Produtores enfileiram via `Queue`; o worker consome via `Worker`/`@Processor`. Retentativas com backoff, jobs atrasados, concorrência, eventos e retenção de jobs falhos já vêm prontos.
- **Prós:** Padrão de fato para jobs em segundo plano no Node; módulo oficial `@nestjs/bullmq` (decorators `@Processor`/`@OnWorkerEvent`, `BullModule.registerQueue`). Retry/backoff robustos, concorrência e semântica de dead-letter (conjunto de falhos) prontos — servindo diretamente o ciclo de status (TD-09). Um container novo (Redis). Documentação excelente. Separação limpa produtor/consumidor que mapeia na divisão API/worker (TD-04).
- **Contras:** Adiciona o Redis como nova infraestrutura. O Redis é um broker at-least-once — os handlers precisam ser idempotentes (aceitável; o processamento é naturalmente idempotente aqui).

### Option B: pg-boss (fila baseada em PostgreSQL)
- Fila de jobs construída sobre o PostgreSQL existente (`SKIP LOCKED`).
- **Prós:** Sem nova infraestrutura — reutiliza o Postgres. Enfileiramento transacional junto às escritas no banco.
- **Contras:** Sem módulo oficial NestJS (fiação manual). Postgres-como-fila acopla a vazão de jobs ao banco primário e disputa conexões/IO com as queries da aplicação. Ecossistema menor; menos recursos prontos (concorrência, rate limiting) que o BullMQ. Para um pipeline de vídeo que se espera escalar workers independentemente, um broker dedicado é mais adequado.

### Option C: RabbitMQ via `@nestjs/microservices`
- Broker AMQP com o transporte de microservices do Nest.
- **Prós:** Roteamento poderoso, broker maduro, transporte NestJS nativo.
- **Contras:** Infraestrutura nova mais pesada (broker + management). O transporte de microservices é orientado a padrões de mensagem/RPC, não à ergonomia de fila de jobs (retry/backoff/jobs atrasados exigem trabalho extra). Exagero para uma fila de processamento de propósito único neste estágio.

**Recommendation:** **Option A (BullMQ + Redis)** — É a escolha nativa do NestJS, com baterias inclusas, para exatamente esta carga: payload de job pequeno, processamento pesado fora de banda, retry/backoff e um worker escalável de forma independente. O custo é um container Redis, leve e também reutilizável depois (rate limiting, cache). O pg-boss economiza um container mas acopla a carga de processamento ao banco primário e carece da integração oficial; o RabbitMQ é desproporcional. A entrega at-least-once do Redis é tranquila dado o processamento idempotente.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq`, `bullmq` (o cliente Redis `ioredis` é transitivo via `bullmq`)

---

## TD-04: Modelo de Execução do Worker

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O processamento com FFmpeg precisa rodar fora da API (é CPU-bound e precisa dos binários `ffmpeg`/`ffprobe`). A decisão é *onde* o consumidor BullMQ roda e como ele é empacotado.

**Options:**

### Option A: Container de worker separado rodando um application context standalone do Nest
- Um segundo entrypoint (`src/worker/main.ts`) sobe o mesmo código NestJS via `NestFactory.createApplicationContext(WorkerModule)` — sem servidor HTTP. O `WorkerModule` registra o `@Processor` do BullMQ mais os providers de storage e DB de que precisa. Um serviço dedicado no Compose `video-worker` é construído a partir de uma imagem de worker que inclui FFmpeg e roda esse entrypoint.
- **Prós:** Isolamento de processo limpo — o trabalho pesado do FFmpeg não pode travar o event loop da API. Reutiliza o mesmo código, DI, config, entidades e serviço de storage (DRY). O worker escala de forma independente (mais réplicas = mais vazão). O FFmpeg fica só na imagem do worker, mantendo a imagem da API enxuta. Mapeia limpa­mente em produtor (API) / consumidor (worker) do BullMQ.
- **Contras:** Um segundo serviço Docker e um segundo alvo de build (Dockerfile do worker com FFmpeg). Um pouco mais de superfície no Compose.

### Option B: Processador in-API (o mesmo processo consome a fila)
- Registra o `@Processor` dentro do processo da API; sem container separado.
- **Prós:** Sem container novo; Compose mais simples.
- **Contras:** O trabalho de CPU do FFmpeg roda no processo da API — disputa diretamente com o atendimento de requisições e pode bloquear/lentificar a API (exatamente o que a fila existe para evitar). O FFmpeg precisa ser instalado na imagem da API (inchaço). Sem escala independente. Anula o propósito do processamento assíncrono.

**Recommendation:** **Option A (container de worker separado, context standalone do Nest)** — O isolamento de processo é o objetivo inteiro de tirar o processamento do caminho da requisição; um processador in-API reintroduz o acoplamento que a fila deveria remover e força o FFmpeg na imagem da API. O serviço Compose extra é um custo pequeno e padrão. O worker reutiliza os módulos existentes via um `WorkerModule` dedicado, então não há duplicação de lógica.

**Decision:** A (Container `video-worker` separado, application context standalone do Nest)

**Libraries:** (nenhuma além do TD-03)

---

## TD-05: Ferramentas de Extração de Metadados e Thumbnail do Vídeo

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O worker precisa ler o vídeo enviado, extrair duração e metadados básicos (codec, largura/altura, bitrate, formato do container) e capturar um único frame como thumbnail JPEG. A ferramenta padrão da indústria é a suíte FFmpeg (`ffprobe` para metadados, `ffmpeg` para a captura do frame). A decisão é como o worker Node aciona esses binários.

**Options:**

### Option A: Invocar os binários `ffprobe`/`ffmpeg` diretamente via `child_process.execFile`
- O worker chama `ffprobe -v quiet -print_format json -show_format -show_streams <input>` (parse do JSON para duração/metadados) e `ffmpeg -ss <t> -i <input> -frames:v 1 -q:v 2 <out.jpg>` (thumbnail). Os binários são instalados na imagem do worker.
- **Prós:** **Zero dependência npm em runtime** para o processamento — apenas os binários do sistema (já na imagem do worker). Controle total sobre as flags; `ffprobe -print_format json` retorna saída limpa e fácil de parsear com tipos. Nenhum pacote depreciado/abandonado na árvore de dependências. Fácil de testar em unidade mockando o wrapper de exec.
- **Contras:** Construção manual de argumentos e parsing de saída (um helper fino e bem contido). Sem abstração fluente.

### Option B: Wrapper `fluent-ffmpeg`
- A popular API fluente em JS sobre o FFmpeg (`ffmpeg(input).screenshots(...)`, `ffmpeg.ffprobe(...)`).
- **Prós:** API encadeada ergonômica; muito usado historicamente; o helper `ffprobe` retorna metadados parseados.
- **Contras:** **O pacote está depreciado** no npm ("Package no longer supported") na versão 2.1.3 — ainda funciona mas não recebe manutenção, o que é um passivo real de longo prazo/qualidade. Além disso, ainda exige os mesmos binários de sistema por baixo, então adiciona uma camada não mantida sobre o que o `execFile` faz diretamente.

**Recommendation:** **Option A (`execFile` direto de `ffprobe`/`ffmpeg`)** — Como os binários são necessários de qualquer forma, a única questão é se vale adicionar uma camada por cima. O `fluent-ffmpeg` está agora depreciado/não mantido, então adicioná-lo importa risco por uma ergonomia de que não precisamos; o `ffprobe -print_format json` já entrega metadados limpos e parseáveis. A invocação direta mantém a superfície de dependência de processamento em zero pacotes npm e é trivialmente mockável para testes de unidade. O thumbnail é capturado em um pequeno offset fixo (ex.: 1s, limitado à duração) para evitar frames iniciais pretos.

**Decision:** A (`execFile` direto de `ffprobe`/`ffmpeg`; FFmpeg instalado na imagem do worker)

**Libraries:** (nenhuma — binários de sistema `ffmpeg`/`ffprobe` na imagem do worker; sem pacote npm)

---

## TD-06: Identificador de URL Pública Única do Vídeo

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de um identificador público curto, URL-safe, pouco previsível e que nunca colida — usado como o handle público nas URLs de streaming/download/visualização. É distinto da chave primária interna UUID (que permanece interna) e da chave de storage (que nunca vaza).

**Options:**

### Option A: `nanoid` (fixado na v3, CommonJS)
- O `nanoid` gera ids aleatórios compactos e URL-safe (ex.: 11–12 chars). Armazenado em uma coluna única; na colisão astronomicamente rara, a constraint única rejeita e regeneramos.
- **Prós:** Minúsculo, rápido, RNG criptograficamente forte, alfabeto URL-safe por padrão. URLs públicas curtas e limpas. Comprovado em produção.
- **Contras:** **Armadilha de versão:** o `nanoid@5` é **somente ESM** e não pode ser `require()`d a partir do build CommonJS do NestJS do projeto — precisa ser fixado em **`nanoid@^3`** (a última linha CommonJS). Esta é uma restrição genuína de compatibilidade cross-component que vale registrar, não um detalhe de implementação.

### Option B: UUID v4 como id público
- Reutilizar um UUID para o handle público.
- **Prós:** Sem dependência nova (Postgres/`crypto` conseguem gerar).
- **Contras:** 36 chars com hífens — URLs públicas longas e feias. Maior do que o necessário para uma URL de visualização. A plataforma quer handles curtos (plano do projeto: "URL curta e única").

### Option C: base62 caseiro sobre `crypto.randomBytes`
- Um helper de ~10 linhas mapeando bytes aleatórios para um alfabeto base62.
- **Prós:** Sem dependência; controle total de comprimento/alfabeto; seguro em CJS.
- **Contras:** Reinventa um problema resolvido; precisa ser cuidadosamente testado para viés/comprimento. O nanoid v3 já fornece isso, validado.

**Recommendation:** **Option A (`nanoid@^3`)** — Handles curtos, URL-safe e resistentes a colisão com um RNG validado, ao custo de uma dependência minúscula. A **fixação ESM/CJS na v3 é obrigatória** e é capturada aqui justamente por ser o tipo de restrição transversal que quebra silenciosamente um build CommonJS se for ignorada. O UUID (B) gera URLs longas e feias, contra a intenção de "URL curta" do plano; um gerador caseiro (C) adiciona risco sem benefício sobre o nanoid v3. Uma coluna única no banco mais regeneração-em-conflito garante que uma colisão nunca chegue à produção.

**Decision:** A (`nanoid@^3`, armazenado em uma coluna única `public_id`, regenera em conflito de constraint única)

**Libraries:** `nanoid@^3`

---

## TD-07: Estratégia de Streaming

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** A reprodução precisa começar sem baixar o arquivo inteiro — ou seja, requisições HTTP **Range** respondidas com **`206 Partial Content`** para que um elemento `<video>` possa buscar (seek) e bufferizar progressivamente. A decisão é quem serve esses ranges.

**Options:**

### Option A: Range-proxy na API — fazer streaming de faixas de bytes do storage por um endpoint fino
- `GET /videos/:publicId/stream` lê o header `Range` do cliente, dispara `GetObjectCommand` ao storage com o mesmo `Range` e devolve o corpo do storage por pipe com `206`, `Content-Range`, `Accept-Ranges: bytes` e `Content-Length` ajustado à fatia. Apenas a fatia solicitada flui (tipicamente alguns MB), não o arquivo inteiro.
- **Prós:** Controle total: o endpoint aplica autorização/visibilidade, esconde as chaves de storage e emite a semântica correta de `206`/`Content-Range`. Funciona de forma idêntica em MinIO e S3. Os dados proxiados são limitados à faixa solicitada, então a memória permanece pequena mesmo para um ativo de 10GB. URL pública única e estável (usa `publicId`).
- **Contras:** Os bytes de reprodução atravessam a API (limitados por faixa). Para escala muito alta, um CDN seria adicionado depois — fora do escopo agora.

### Option B: Redirecionar para uma presigned URL do storage e deixar o cliente fazer range direto no storage
- O endpoint faz um redirect 302 para uma presigned URL de `GetObject` de curta duração; o navegador faz as requisições de range direto contra o storage.
- **Prós:** Os bytes de reprodução contornam a API totalmente.
- **Contras:** Expõe uma URL de storage direta (ainda que temporária); mais difícil aplicar autorização por requisição e regras de visibilidade/unlisted (de uma fase futura). A expiração da presigned URL vs. sessões longas de visualização precisa de tratamento. A semântica de range/seek depende do comportamento do presigned-GET do storage. Acopla o contrato público às URLs de storage em vez de a uma rota estável da API.

**Recommendation:** **Option A (range-proxy na API com `206`)** — Mantém uma URL pública única, estável e autorizável enquanto emite a semântica correta de partial-content, limitando a memória da API a uma faixa por vez. A Fase 03 não tem requisito de CDN; quando a escala exigir, um CDN/redirect pode ser sobreposto sem mudar o contrato público. O redirect-para-presigned (B) vaza URLs de storage e complica as regras de autorização/visibilidade que fases posteriores anexam à reprodução.

**Decision:** A (Range-proxy na API, `206 Partial Content` a partir do storage)

**Libraries:** (coberto pelo TD-01)

---

## TD-08: Estratégia de Download

**Scope:** Backend

**Capability:** Download do vídeo pelo usuário

**Context:** Usuários podem baixar o arquivo de vídeo original completo. Diferente do streaming (faixas limitadas, precisa ser autorizável por requisição), um download é uma transferência única de objeto inteiro onde tirar a carga da API é o mais valioso.

**Options:**

### Option A: Presigned `GET` URL com disposição de anexo (attachment)
- `GET /videos/:publicId/download` retorna (ou faz redirect 302 para) uma presigned URL de `GetObject` de curta duração carregando `response-content-disposition: attachment; filename="..."`. O cliente puxa o arquivo completo **direto do storage**.
- **Prós:** A transferência completa (até 10GB) nunca atravessa a API — sem custo de memória/conexão da API para downloads grandes. `Content-Disposition: attachment` força um download com nome de arquivo amigável. Trivial de implementar sobre o presigner já escolhido no TD-01.
- **Contras:** Expõe brevemente uma URL de storage limitada no tempo (aceitável; expiração mantida curta).

### Option B: Proxy do objeto inteiro pela API
- Canalizar o corpo inteiro do `GetObject` pela API até o cliente.
- **Prós:** A URL de storage nunca é exposta; um caminho de código consistente com o streaming.
- **Contras:** Um download completo de 10GB prende uma conexão da API durante toda a transferência e reintroduz o custo de repasse que o desenho de upload (TD-02) deliberadamente evita. Mau encaixe para arquivos grandes em qualquer concorrência.

**Recommendation:** **Option A (presigned `GET`, disposição de anexo)** — Downloads são transferências de objeto inteiro onde o repasse pela API é mais caro; o presign tira a transferência inteira para o storage e gera um nome de arquivo `attachment` adequado, consistente com a filosofia de direto-ao-storage estabelecida para o upload. O streaming continua sendo um proxy na API (TD-07) porque precisa de autorização por faixa e URLs estáveis; o download não, então o caminho presigned mais barato vence.

**Decision:** A (Presigned `GET` URL com `response-content-disposition: attachment`)

**Libraries:** (coberto pelo TD-01)

---

## TD-09: Ciclo de Status do Vídeo e Tratamento de Falha de Processamento

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload

**Context:** Uma linha de vídeo existe antes de seus bytes (pré-cadastrada como rascunho quando o upload começa) e percorre o processamento até um estado terminal. O enum de status é um contrato cross-component: a entidade/migration o definem, a API escreve as transições iniciais e o worker escreve as transições terminais. A decisão é o conjunto exato de estados, as transições e o que acontece em caso de falha de processamento.

**Options:**

### Option A: `draft → processing → ready | error`, com retentativas do BullMQ antes de `error`
- **draft:** linha criada no início do upload (TD-10), antes/enquanto os bytes são enviados. **processing:** definido quando o cliente confirma a conclusão do upload e o job de processamento é enfileirado. **ready:** worker teve sucesso — duração/metadados persistidos, thumbnail armazenado. **error:** worker falhou após o BullMQ esgotar suas tentativas de retry/backoff (jobs falhos retidos para inspeção). Streaming/download só são servidos para vídeos `ready`.
- **Prós:** Ciclo de vida mínimo e intuitivo que mapeia 1:1 com a redação do plano ("rascunho → processando → pronto/erro"). O retry/backoff embutido do BullMQ absorve falhas transitórias de FFmpeg/storage antes de declarar `error`. O `error` terminal é observável (linha + job falho retido) e reexecutável. Gate claro para o que é publicamente reproduzível.
- **Contras:** Ainda não modela visibilidade `published` vs `unlisted` — mas isso é explicitamente escopo da Fase 04, não desta fase.

### Option B: Flags booleanas (`is_processed`, `has_error`)
- Dois booleanos em vez de um enum.
- **Prós:** Sem tipo enum.
- **Contras:** Estados ilegais representáveis (`is_processed && has_error`), sem fonte única de verdade, desajeitado para servir de gate ao streaming. Um enum explícito é mais claro e combina com o estilo existente do projeto (o precedente do enum `verification_tokens.type`).

**Recommendation:** **Option A (enum explícito `draft → processing → ready | error`)** — Combina com o ciclo de vida exato do plano, dá uma coluna de status autoritativa única para servir de gate à reprodução e se apoia no retry/backoff do BullMQ para que `error` só seja alcançado após esgotar falhas transitórias. Um job falho permanece no conjunto de falhos da fila para diagnóstico e reexecução manual. Flags booleanas (B) admitem estados contraditórios e obscurecem o gate. A visibilidade (`published`/`unlisted`) é intencionalmente adiada para a Fase 04.

**Decision:** A (enum `draft → processing → ready | error`; retry+backoff do BullMQ; falha → `error` após esgotar tentativas; apenas `ready` é reproduzível/baixável)

**Libraries:** (nenhuma além do TD-03)

---

## TD-10: Gatilho de Conclusão de Upload (como o processamento começa)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Com o upload direto-ao-storage (TD-02), a API **não** vê os bytes chegarem, então ela precisa de um sinal explícito de que o upload terminou para (a) concluir o multipart upload, (b) virar o status para `processing` e (c) enfileirar o job de processamento. A decisão é o mecanismo para esse sinal.

**Options:**

### Option A: Endpoint de conclusão acionado pelo cliente + verificação no storage
- Contrato de API em três etapas: **(1) início** (`POST /videos`) — cria a linha rascunho (status `draft`, `public_id` atribuído), `CreateMultipartUpload`, retorna o `videoId`, o `uploadId` e as presigned URLs das partes. **(2)** o cliente envia as partes direto ao storage. **(3) conclusão** (`POST /videos/:id/complete` com os ETags das partes) — a API chama `CompleteMultipartUpload`, dispara um `HeadObject` para verificar que o objeto existe e capturar seu tamanho, vira o status para `processing` e enfileira o job no BullMQ. O worker então processa e vira para `ready`/`error`.
- **Prós:** Sem infraestrutura extra — o cliente já sabe quando seu upload terminou. A verificação `HeadObject` protege contra enfileirar para um objeto ausente/parcial. Determinístico, fácil de testar de ponta a ponta. A chamada de conclusão é o lugar natural para exigir os ETags do multipart. Encaixa exatamente no desenho de multipart presigned.
- **Contras:** Depende de o cliente chamar `complete` (um upload nunca concluído simplesmente permanece `draft` — aceitável; tais rascunhos podem ser coletados depois/fora do escopo).

### Option B: Notificações de evento do bucket S3/MinIO → webhook
- Configurar o MinIO para fazer POST de uma notificação de bucket na criação de objeto; um webhook na API vira o status e enfileira.
- **Prós:** Sem chamada de `complete` do cliente; o storage é a fonte da verdade da conclusão.
- **Contras:** Exige configurar notificações de evento do MinIO (infra/config extra que diverge de setups S3 simples), um endpoint de webhook público e correlação evento-para-vídeo. Para multipart, a conclusão ainda precisa ser disparada por alguém chamando `CompleteMultipartUpload` — as notificações disparam apenas **depois** da conclusão, então isso não remove a necessidade de uma etapa de conclusão; apenas move o gatilho do enfileiramento. Complexidade adicionada líquida sem ganho aqui.

**Recommendation:** **Option A (endpoint `complete` acionado pelo cliente com verificação `HeadObject`)** — Alinha-se exatamente com o multipart presigned (alguém precisa chamar `CompleteMultipartUpload` de qualquer forma), não precisa de infraestrutura de notificação e deixa a API verificar o objeto antes de enfileirar. A etapa de início é onde o pré-cadastro do rascunho (uma capacidade exigida) acontece naturalmente. As notificações de bucket (B) adicionam um webhook e config específica do MinIO sem remover a etapa de conclusão que o multipart inerentemente exige.

**Decision:** A (início `POST /videos` cria rascunho + multipart + partes presigned; `POST /videos/:id/complete` finaliza, verifica via `HeadObject`, vira para `processing`, enfileira o job)

**Libraries:** (coberto pelo TD-01 e TD-03)

---

## Resumo das Decisões

| Ref | Tópico | Decisão | Novas libs/infra |
|-----|--------|---------|------------------|
| TD-01 | Cliente de object storage e layout | AWS SDK v3, bucket único, chaves por id | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`; container MinIO |
| TD-02 | Estratégia de upload de 10GB | Multipart presigned, direto ao storage | — |
| TD-03 | Tecnologia de fila | BullMQ + Redis | `@nestjs/bullmq`, `bullmq`; container Redis |
| TD-04 | Execução do worker | Container `video-worker` separado (Nest standalone) | imagem de worker c/ FFmpeg |
| TD-05 | Metadados e thumbnail | `execFile` direto de `ffprobe`/`ffmpeg` | binários FFmpeg (sem npm) |
| TD-06 | Id de URL pública única | `nanoid@^3` (CJS), `public_id` único | `nanoid@^3` |
| TD-07 | Streaming | Range-proxy na API, `206 Partial Content` | — |
| TD-08 | Download | Presigned `GET`, disposição de anexo | — |
| TD-09 | Ciclo de status | `draft → processing → ready \| error`, retentativas do BullMQ | — |
| TD-10 | Gatilho de conclusão de upload | Endpoint `complete` do cliente + verificação `HeadObject` | — |
