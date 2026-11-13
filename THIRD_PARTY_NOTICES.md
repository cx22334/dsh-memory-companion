# Third-party sources and attribution

This source distribution retains the licenses of included upstream files. The combined plugin is distributed under CC BY-NC-SA 4.0; independently licensed upstream components retain their original terms and notices. No claim of upstream endorsement is made.

## Included source / native assets

- **VCPToolBox** — https://github.com/lioensky/VCPToolBox — pinned commit `73fd165d858d64d6c849533b3ec8e01c34f69e12` (2026-11-13T06:08:23Z). Included under `vendor/vcp/`: original TagMemo/River wrappers, supporting modules, Rust source and matching Windows x64 / Linux x64 GNU native binaries. Root license: Creative Commons Attribution-NonCommercial-ShareAlike 4.0, retained in `vendor/vcp/LICENSE`; nested notices remain in place. Plugin-specific integration is in `src/tagmemo-adapter.mjs`; it adapts ingestion, ACL domains, note/revision mappings and candidate retrieval without claiming to author the original algorithms. Source snapshot metadata accompanies the vendor tree.
- **dsh-vcprag** — https://github.com/YumenoSayuri/dsh-vcprag — recorded checkout `afc01ec752c5e33e925939ac740f03c93c132f73`. Copyright 2026 YumenoSayuri; MIT. `lib/bm25.js` and `lib/tokenize.js` are included as `vendor/vcprag/bm25.js` and `tokenize.js` with the upstream license. Source was read from the local working tree; the recorded HEAD is not an attestation that the working tree was unmodified. This plugin uses the gram tokenizer, not an installed jieba dependency.
- **TriviumDB** — npm package `triviumdb`, pinned `0.9.0`, Apache-2.0. Installed through npm as an optional native dependency; its absence is reported and allows lexical fallback. The VCP native crate has its own retained license files. No replacement database is presented as the npm package.
- **yaml** — npm package `yaml`, pinned `2.8.1`; its package license applies to the installed dependency. It parses and serializes diary front matter. npm package dependencies are not vendored in node_modules in this delivery.

## Reference projects, not bundled runtimes

- https://github.com/menglimi/astrbot_plugin_private_companion — reviewed for exact evidence, fixed batches, idempotency and unknown-outcome job handling. Its Python application and database were not copied into this plugin. Recorded checkout: `38212f66de2a3629fbbac41416525fc519d0f195`, version 7.1.17.
- https://github.com/YumenoSayuri/dsh-workspace-docs — reference for native named-context registration.
- https://github.com/YumenoSayuri/dsh-github-sync — reference for tool and command registration. A model-supplied confirmation flag is not treated as human approval here.
- https://github.com/YumenoSayuri/astrbot_plugin_nova_CrossFlow — reference for capture boundaries and synthetic-event exclusion; no runtime imported.
- https://github.com/YumenoSayuri/dsh-time-weaver — inspected; history monkey-patching not adopted.
- https://github.com/YumenoSayuri/astrbot_plugin_nova_omni and https://github.com/YumenoSayuri/ModelMindHijacker — inspected; not incorporated.

VCP AgentDream, timeline and note-management mechanisms informed proposal-based organization, but their destructive maintenance actions were not used as the Vault transaction implementation. This package does not require a running VCP server.

No upstream project is said to have reviewed, tested or approved this integration.
