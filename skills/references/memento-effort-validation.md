# Memento effort validation — 2026-09-29

Candidate: 7.6.0-memento.1, upstream 7.6.0 plus Memento fork features.

The gateway configuration includes 97 installed model routes with verified named effort metadata or documented budget aliases, under each of the two existing billing keys. Internal previews and toggle-only models without verified level controls are unchanged; this is not a claim that all configured models are available to the account.

Direct live hello-world coverage: 355 distinct model/effort pairs across 87 model routes returned HTTP 200 and hello world. Tests used short prompts without tools. Main requests alternated the existing gateway keys; credentials stayed in memory. Invalid Sonar `none` variants from cross-provider catalog metadata were corrected to minimal/low/medium/high after provider validation.

End-to-end Claw MCP → OpenCode → gateway probes confirmed the actual outgoing payload and native user-record variant: Opus 5.5 high uses Anthropic adaptive thinking/output_config.effort; Sol max uses Responses reasoning.effort; Gemini 3.8 high uses Chat Completions reasoning_effort; Haiku high uses a 16,384-token thinking budget. Each returned hello world. Title-generation requests are separate auxiliary requests and can use low effort.

Native wrapper hello-world checks passed Fable 5.1 xhigh, Opus 5.5 xhigh, Sonnet 4.6 high, Sonnet 5.5 xhigh, Haiku auto, Cursor Grok 4.6 xhigh, and Composer 2.5 auto. Codex app-server checks confirmed Sol xhigh and Luna max from thread state, and Astra auto/high/auto restored its original low setting after a one-turn high override. The native protocol's null effort does not clear an override; the wrapper restores the initial effective session setting explicitly.

## Provider availability exceptions

- Cursor Gemini 3.8 Flash High is listed locally but rejected by the team's inference-region policy. The NVIDIA/OpenCode route passed.
- Cursor's installed catalog has Grok 4.6 effort IDs but no Grok 4.7. The wrapper refuses to substitute another model version. OpenCode Grok 4.7 passed its four effort levels.
- Azure GPT-6 Sol low/medium/high encountered provider token quota errors; its other tested levels passed. The separate OpenAI route passed all supported levels.
- NVIDIA GLM 5.2 was saturated (429); no client bypass or quota change was attempted.
- Inkling Small returned 410 (retired). Eight pre-existing unqualified catalog aliases returned 403 (not allowed by these keys); no access-control changes or alternate-credential retries were attempted. Those entries are not reported as working.
- Sonar Deep Research minimal returned hello world, while low/medium/high exceeded the bounded probe's response timeout. Sonar Reasoning Pro passed minimal/low/medium/high.

## Checks

Source build, ESLint and formatting checks pass. Runtime suite: 1,831 tests across 90 files. Real kernel tests preserve fanout/council child identity, terminal Memento lifecycle events and eight-way unlimited fanout. Protocol tests cover exact native effort fields, per-turn restoration, resume/read-only behavior and Cursor family-preserving selection.

The upstream optional weekly sweep reported no price drift across 30 checked models and successful ACP/MCP handshakes. Its native Grok version lookup was unavailable and its binary-string Codex model discovery could not inspect the installed launcher; live native Codex tests above provide separate evidence. No engine version was changed.

The separate optional `typecheck:tests` command is not green upstream: the exact upstream baseline reports 100 fixture typing errors. This release fixes the new effort fixture typing; remaining pre-existing fixture errors are recorded separately from the passing production build and runtime suite.

Sources: [OpenCode variant configuration](https://opencode.ai/docs/models/), [gateway schema](https://inference-api.nvidia.com/openapi.json), [Gemini effort translation](https://docs.litellm.ai/docs/providers/gemini), [Cursor Grok 4.7](https://cursor.com/docs/models/grok-4-7).
