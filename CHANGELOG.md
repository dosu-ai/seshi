# [0.26.0](https://github.com/dosu-ai/seshi/compare/v0.25.0...v0.26.0) (2026-11-21)


### Features

* drop the remaining sessiondb names ([#71](https://github.com/dosu-ai/seshi/issues/71)) ([ba3645c](https://github.com/dosu-ai/seshi/commit/ba3645ceec923a9a112e26b21e8ee93026deec23))

# [0.25.0](https://github.com/dosu-ai/seshi/compare/v0.24.0...v0.25.0) (2026-11-21)


### Features

* **store:** Azure Blob Storage as a store and source bucket (az://) ([#68](https://github.com/dosu-ai/seshi/issues/68)) ([da8cf3a](https://github.com/dosu-ai/seshi/commit/da8cf3abc8f0bdb2af70abf924cadfc0bf00f2d9))
* **store:** Google Cloud Storage as a store and source bucket (gs://) ([#69](https://github.com/dosu-ai/seshi/issues/69)) ([6d28cae](https://github.com/dosu-ai/seshi/commit/6d28caeb2d524460f9792317aa13cfd0c7e8994a)), closes [#68](https://github.com/dosu-ai/seshi/issues/68)

# [0.24.0](https://github.com/dosu-ai/seshi/compare/v0.23.0...v0.24.0) (2026-11-20)


### Features

* **sessions:** owners read and search their own sessions with any credential ([#66](https://github.com/dosu-ai/seshi/issues/66)) ([bf480c8](https://github.com/dosu-ai/seshi/commit/bf480c8d90e0da8972e1716ad79cd0586ce7803c)), closes [#63](https://github.com/dosu-ai/seshi/issues/63)

# [0.23.0](https://github.com/dosu-ai/seshi/compare/v0.22.0...v0.23.0) (2026-11-20)


### Features

* **capture:** /session-capture share and unshare in pi, OpenCode, Codex and Cursor ([#64](https://github.com/dosu-ai/seshi/issues/64)) ([555486e](https://github.com/dosu-ai/seshi/commit/555486e45e87b84cee5f4a03f5b25b62fffd38e4))
* **sessions:** owners share and unshare their own sessions (seshi share) ([#63](https://github.com/dosu-ai/seshi/issues/63)) ([c0bbfce](https://github.com/dosu-ai/seshi/commit/c0bbfce9a4dfb8e62a80bb5628a25030b359d77c))

# [0.22.0](https://github.com/dosu-ai/seshi/compare/v0.21.0...v0.22.0) (2026-11-20)


### Features

* **capture:** hold the org's tool-call redaction list on the server ([capture] redact_tool_calls) ([#56](https://github.com/dosu-ai/seshi/issues/56)) ([38c4469](https://github.com/dosu-ai/seshi/commit/38c4469634e65a28cb6c9ed53ccc284e18ca48d7)), closes [#51](https://github.com/dosu-ai/seshi/issues/51)

# [0.21.0](https://github.com/dosu-ai/seshi/compare/v0.20.0...v0.21.0) (2026-11-20)


### Features

* **npm:** publish the launcher as `seshi` too ([#55](https://github.com/dosu-ai/seshi/issues/55)) ([9ff9390](https://github.com/dosu-ai/seshi/commit/9ff93904c877f7a47b8a14cab42b5328b47896b9))

# [0.20.0](https://github.com/dosu-ai/seshi/compare/v0.19.0...v0.20.0) (2026-11-20)


### Features

* **capture:** hold the org's exclude list on the server ([#51](https://github.com/dosu-ai/seshi/issues/51)) ([63ea768](https://github.com/dosu-ai/seshi/commit/63ea7684a33b25c46091145fb845e0a3b9b8b0ae)), closes [dosu-ai/seshi#49](https://github.com/dosu-ai/seshi/issues/49) [dosu-ai/seshi#49](https://github.com/dosu-ai/seshi/issues/49)

# [0.19.0](https://github.com/dosu-ai/seshi/compare/v0.18.0...v0.19.0) (2026-11-20)


### Features

* **capture:** upload a listed place's sessions with tool calls redacted (capture.redact_tool_calls) ([#52](https://github.com/dosu-ai/seshi/issues/52)) ([b3ff509](https://github.com/dosu-ai/seshi/commit/b3ff509ab3279d78b13ee387c2273583e78e751a))

# [0.18.0](https://github.com/dosu-ai/seshi/compare/v0.17.0...v0.18.0) (2026-11-20)


### Features

* record where and with what a session ran (repo, commit, folder, client, harness version, models) ([#49](https://github.com/dosu-ai/seshi/issues/49)) ([e7b0653](https://github.com/dosu-ai/seshi/commit/e7b065372fda974c58316e4eacb1339145b30887))

# [0.17.0](https://github.com/dosu-ai/seshi/compare/v0.16.0...v0.17.0) (2026-11-20)


### Features

* session labels from config, uploaded, stored and searchable ([#50](https://github.com/dosu-ai/seshi/issues/50)) ([10563ce](https://github.com/dosu-ai/seshi/commit/10563ce97eee168fa115157fcde61319e3b375b2))

# [0.16.0](https://github.com/dosu-ai/seshi/compare/v0.15.0...v0.16.0) (2026-11-20)


### Features

* name the session's format `format`, and read sessions by owner and archive id ([#48](https://github.com/dosu-ai/seshi/issues/48)) ([4ef6169](https://github.com/dosu-ai/seshi/commit/4ef616960765dd53a9fbdcf1729b66aacce3bad7))

# [0.15.0](https://github.com/dosu-ai/seshi/compare/v0.14.0...v0.15.0) (2026-11-20)


### Features

* **capture:** org exclude list (capture.exclude) ([#47](https://github.com/dosu-ai/seshi/issues/47)) ([975b91c](https://github.com/dosu-ai/seshi/commit/975b91c0e2b779d30a185d5d81d067be86532ab4))

# [0.14.0](https://github.com/dosu-ai/seshi/compare/v0.13.0...v0.14.0) (2026-11-20)


### Features

* **cursor:** poll Cursor Cloud agents through the Cloud Agents API (F7) ([#46](https://github.com/dosu-ai/seshi/issues/46)) ([2648e7a](https://github.com/dosu-ai/seshi/commit/2648e7a85b6c76006acf78d3a8444f3d5df90090))

# [0.13.0](https://github.com/dosu-ai/seshi/compare/v0.12.0...v0.13.0) (2026-11-19)


### Features

* **cursor:** drop Cursor Cloud hook mode; F7 is the only Cursor Cloud path ([#44](https://github.com/dosu-ai/seshi/issues/44)) ([bf8c914](https://github.com/dosu-ai/seshi/commit/bf8c9149c842230d034f6f6ee4a580dd277966b8))

# [0.12.0](https://github.com/dosu-ai/seshi/compare/v0.11.0...v0.12.0) (2026-11-19)


### Features

* **cursor:** tool results in Cursor sessions, from postToolUse ([#42](https://github.com/dosu-ai/seshi/issues/42)) ([5e1b364](https://github.com/dosu-ai/seshi/commit/5e1b3647f35a9417e295079653b5a3e08fc3d7d1))

# [0.11.0](https://github.com/dosu-ai/seshi/compare/v0.10.0...v0.11.0) (2026-11-19)


### Features

* **client:** a Python client for the seshi API ([#38](https://github.com/dosu-ai/seshi/issues/38)) ([daa28ac](https://github.com/dosu-ai/seshi/commit/daa28ac2626d542b25cf05cfa8cf5cc1310b51e8)), closes [docs/releasing.md#pypi](https://github.com/docs/releasing.md/issues/pypi)

# [0.10.0](https://github.com/dosu-ai/sessiondb/compare/v0.9.0...v0.10.0) (2026-11-19)


### Bug Fixes

* **api,pipeline:** service-token uploads go under the service's source ([8cac4ee](https://github.com/dosu-ai/sessiondb/commit/8cac4eee1a09416878f6636dfb12bb06160d9029))
* **api:** a retraction finds the session across the caller's aliased folders (F9.7) ([9328446](https://github.com/dosu-ai/sessiondb/commit/93284466800290e48b77424e189d3feb12323f9f))
* **api:** bound the decoded request body ([53d3935](https://github.com/dosu-ai/sessiondb/commit/53d3935cea529bbc326f460bb9a01b8127e00497))
* **api:** inflate gzipped JSON bodies as a capped stream ([598d361](https://github.com/dosu-ai/sessiondb/commit/598d361f6f4492f3e45e161d07d88801b560aea2))
* **api:** name both reasons a span is left out in partial_success ([d0d20e4](https://github.com/dosu-ai/sessiondb/commit/d0d20e4a7d0a22e64cb5d172eda29055389a836c))
* **api:** refuse an oversized JSON body before buffering it ([0f53227](https://github.com/dosu-ai/sessiondb/commit/0f53227994ff4967626ea8db81e80650c2d7c3a9))
* **api:** revoke by owner takes an owner id ([3c575b4](https://github.com/dosu-ai/sessiondb/commit/3c575b447e073ef6db1aa1aa68a93779af047c3a))
* **api:** serve only the trace objects a session names ([6c48e22](https://github.com/dosu-ai/sessiondb/commit/6c48e22afa075876b830b25943e0e84c3b659451))
* **auth:** keep org-key callers off sessions whose owner was verified ([9791ac8](https://github.com/dosu-ai/sessiondb/commit/9791ac86b3dbe731bf7c231be94448eae71b7062))
* **auth:** make an org-key replace prove the uploading machine with its retraction secret ([fcafb16](https://github.com/dosu-ai/sessiondb/commit/fcafb16cc887799d2663b0b80338b8b7973576d1))
* **auth:** name a static token by its owner, not a hash of the secret ([ce250ed](https://github.com/dosu-ai/sessiondb/commit/ce250ed448d837b9d8a16e7c88678ea2f9e7a40c))
* **auth:** refuse .env.example's placeholder static tokens ([242c472](https://github.com/dosu-ai/sessiondb/commit/242c472dc76f149988632a7e615f7ec9a9fd7868))
* **auth:** refuse an unverified email as owner id, bound the org-key username claim ([cad1ef0](https://github.com/dosu-ai/sessiondb/commit/cad1ef06e4caa75dc683d154ba300efe9ff02b33))
* **build:** the compiled binary reads no .env or bunfig.toml from the working folder ([453b988](https://github.com/dosu-ai/sessiondb/commit/453b98875849b77ac3600877b88a47c8688a7e14))
* **capture:** a repo's config may only narrow visibility ([995aca1](https://github.com/dosu-ai/sessiondb/commit/995aca1ee3d1a01257fd36e91dda156c5445c839))
* **capture:** address review findings on OpenCode 2.x capture ([1b84bb3](https://github.com/dosu-ai/sessiondb/commit/1b84bb32831ad6d82c792ae9dcb1091100bb22d0))
* **capture:** address review findings on the OpenCode database sweep ([fa4e316](https://github.com/dosu-ai/sessiondb/commit/fa4e316c678ed2cd74d366fc1fd4f696ad30d1ed))
* **capture:** beat between sessions in a long pass, and stop when taken over ([e8332dd](https://github.com/dosu-ai/sessiondb/commit/e8332dd91788d2e3960938a7066607c8425df1f2))
* **capture:** Cursor Cloud hooks retract continuations whole and finish in time ([7ff1bf0](https://github.com/dosu-ai/sessiondb/commit/7ff1bf0b6c3fd8658bfc4a2507bcabdabf9f5996))
* **capture:** do not call off a waiting retraction when a session is turned on ([1a713b6](https://github.com/dosu-ai/sessiondb/commit/1a713b659ff5f45aa597a41be3a9fbef6e319858))
* **capture:** follow a paused session's transcript when it moves ([f8557be](https://github.com/dosu-ai/sessiondb/commit/f8557bec4de37f176c627bfc5709ca87ece65ae9))
* **capture:** forget the last answer when offset_mismatch moves the offsets ([a32ca28](https://github.com/dosu-ai/sessiondb/commit/a32ca28610c19836b7c3f2e70d96affb5b657f8c))
* **capture:** give git's own config 4 MiB before a repo counts as unreadable ([fbfd829](https://github.com/dosu-ai/sessiondb/commit/fbfd8291a1a93a7e3ee375615dc62cc5c9a4c08f))
* **capture:** identify the transcript before every piece, and resend a moved one whole ([c13518e](https://github.com/dosu-ai/sessiondb/commit/c13518ebf7294d0295c4037981debafda328b58b))
* **capture:** judge a session by every folder it was seen in ([3da3c42](https://github.com/dosu-ai/sessiondb/commit/3da3c42a99d1a221ffadd68bf0dbbe6b14bb0845))
* **capture:** judge subagents by their ancestors' folders ([18c597a](https://github.com/dosu-ai/sessiondb/commit/18c597a6bbf462fee8c65cf6b0f00e11a3650f63))
* **capture:** keep /seshi working until reinstall, and tidy the rename ([252b6b1](https://github.com/dosu-ai/sessiondb/commit/252b6b1ee29338d08e2bc7d12431dbf2370821e0))
* **capture:** keep a session toggle set before any hook named the transcript ([70057c6](https://github.com/dosu-ai/sessiondb/commit/70057c68cdbf800c9b745d2d8ccb44a2b07e7eb3))
* **capture:** keep a session turned off whose transcript moved ([d2901e4](https://github.com/dosu-ai/sessiondb/commit/d2901e4563d87c430374f7a51735b0a0c422cc4d))
* **capture:** keep any session whose transcript moved, not only one turned off ([82e8158](https://github.com/dosu-ai/sessiondb/commit/82e81581d0935b90f8799801d0bfccc49518dad1))
* **capture:** key the rules cache on every SESHI_ setting variable ([218ebf3](https://github.com/dosu-ai/sessiondb/commit/218ebf3a7a3e838dad590febab610524d0f43198))
* **capture:** let a session's toggle cover its subagents ([7670749](https://github.com/dosu-ai/sessiondb/commit/7670749ae83eb7e02399f8a2d6485ecd2fd57d08))
* **capture:** let one uploader at a time take over a stale lock ([fd048c3](https://github.com/dosu-ai/sessiondb/commit/fd048c35764fd137428ac332c2582a92123ba203))
* **capture:** name the piece in a rebuild's idempotency key ([9b6f163](https://github.com/dosu-ai/sessiondb/commit/9b6f1635ec092319f7fe3fdea64422ec38ef29f2))
* **capture:** never report a stored session as retracted when the server cannot find it ([87d1d76](https://github.com/dosu-ai/sessiondb/commit/87d1d76222a88768ca0a5eed73d60aa3abc5fdc9))
* **capture:** pi and OpenCode capture after review ([20f3297](https://github.com/dosu-ai/sessiondb/commit/20f3297ff03955d110b133961cfbc7bf67e6aa9b))
* **capture:** read a repo's config and git files bounded ([659bf70](https://github.com/dosu-ai/sessiondb/commit/659bf70a10f11ac2a371ac5a96beb43494ebe42c))
* **capture:** read git identity from the command's home ([e13d7a5](https://github.com/dosu-ai/sessiondb/commit/e13d7a510b865c3b89d42d9a87bb543b2e83857a))
* **capture:** record a length-changing piece as misaligned when it is sent ([9c5a5ef](https://github.com/dosu-ai/sessiondb/commit/9c5a5ef89ffdece50ef9c2272fc9757bbb42e1dd))
* **capture:** replace on conflict a session whose answer was lost ([e99473a](https://github.com/dosu-ai/sessiondb/commit/e99473afa7ab489b655d07df210bb85f6881efc9))
* **capture:** send nothing of a session turned off just before its first upload ([6564d64](https://github.com/dosu-ai/sessiondb/commit/6564d64c6a6cddb044750163bdfe2f3ce416ff21))
* **capture:** send only a file the agent identifies as the session's transcript ([d0b8494](https://github.com/dosu-ai/sessiondb/commit/d0b84940173f4ded0279b38c5a7e4ad62f541af8))
* **capture:** send sessions seen at the same moment in key order ([0852fc3](https://github.com/dosu-ai/sessiondb/commit/0852fc3e1d973bf467f6529c767951d4d27f1a0a))
* **capture:** the capture notice names the agent's own command, /seshi in Cursor ([6e06f4f](https://github.com/dosu-ai/sessiondb/commit/6e06f4f0770e265c3e36d986643b7230c2473147))
* **capture:** the seshi skill asks to run outside a sandbox instead of giving up ([ca7bb6a](https://github.com/dosu-ai/sessiondb/commit/ca7bb6aaf2d12818d3d9e7387bc406071c6a550b))
* **capture:** tighten the OpenCode TUI plugin's /seshi and status ([0bf53ba](https://github.com/dosu-ai/sessiondb/commit/0bf53ba38e8acf85b6d63a7bec0b06e6b8e9e1d3))
* **capture:** wire capture resend to the pause's session check, and test a frozen rebuild ([772becf](https://github.com/dosu-ai/sessiondb/commit/772becfb28e334d32bcdab8be338ed2f48662cc4))
* **ci:** Bun 1.4 TOML errors carry no position; copy the explore favicon into the image ([3d28f47](https://github.com/dosu-ai/sessiondb/commit/3d28f478525e966e9fe2100f9889d3ea8fee5458))
* **cli:** answer <command> --help with the command's usage ([42f34e8](https://github.com/dosu-ai/sessiondb/commit/42f34e8e21edc4ad98ad0a44f02acb9e084ac917))
* **cli:** capture status --session shows only that session ([168c7ac](https://github.com/dosu-ai/sessiondb/commit/168c7ac098f21d126750323532497e8225494a39))
* **cli:** carry the agents' folder variables into the service entry too ([7fa5c4c](https://github.com/dosu-ai/sessiondb/commit/7fa5c4c1ae719b516219ef7110b4b2e0d8ef5b31))
* **cli:** fail when a command stops before it finishes; diagnose an empty login ([c1004f9](https://github.com/dosu-ai/sessiondb/commit/c1004f98a278999ceb07a31e761abaeba2c250da))
* **cli:** flush stdout and stderr before exiting ([21ac803](https://github.com/dosu-ai/sessiondb/commit/21ac8038bd4540f0ab3110d20c195c47ba5eed3f))
* **cli:** give the service entry the folders the hooks use ([897a65f](https://github.com/dosu-ai/sessiondb/commit/897a65f089a468d4ed6f9aa38d38cb9759f29fbe))
* **cli:** name seshi traffic seshi/<version>, not the old SDK's user agent ([5b8e3b0](https://github.com/dosu-ai/sessiondb/commit/5b8e3b01a11d28812c18ee19c09afc8179131f14))
* **cli:** open and call only https IdP endpoints ([bbdf84b](https://github.com/dosu-ai/sessiondb/commit/bbdf84bb101f00666d7a253ede44fa014bb775f8))
* **cli:** point seshi reprocess at capture resend for uploaded sessions ([2f254e6](https://github.com/dosu-ai/sessiondb/commit/2f254e67e7313705da6836113cf8eb60b6bb9e35))
* **cli:** read ./seshi.toml unasked in seshi serve only ([940ef23](https://github.com/dosu-ai/sessiondb/commit/940ef2333f61e31714d4d59251bfd921e233187c))
* **cli:** read standard input through process.stdin, not Bun.stdin.text() ([9215491](https://github.com/dosu-ai/sessiondb/commit/921549178aae573b830628d4b6e2064fcc62e07d))
* **cli:** refuse to guess which session --session means when several ran here ([4616b99](https://github.com/dosu-ai/sessiondb/commit/4616b9935e1c6261ddf7612d5f430f060d0ab6a1))
* **cli:** run the retention job once with seshi sync prune ([5394858](https://github.com/dosu-ai/sessiondb/commit/539485800d00ce72080753573bf98e346dd97cfc))
* **cli:** say what a capture pause does, not that nothing is captured ([330fd2f](https://github.com/dosu-ai/sessiondb/commit/330fd2fef33c90948cb07085dc60159909eb85a5))
* **cli:** say what serverless mode does on off, visibility and a repeat upload ([512120e](https://github.com/dosu-ai/sessiondb/commit/512120e67f6d39d870093499cad2ed38d9dd4675))
* **cli:** show a capture pause in status only while it holds ([3b0571f](https://github.com/dosu-ai/sessiondb/commit/3b0571f4a0bd2416e09e275e4f1cc5645704f1f0))
* **cli:** take --json in admin init and healthcheck ([f23e33a](https://github.com/dosu-ai/sessiondb/commit/f23e33af0357a427b3dad657ac76dd2a7f1edc95))
* **cli:** uninstall the agents it can when one agent's config is unreadable ([fabbf81](https://github.com/dosu-ai/sessiondb/commit/fabbf81f9e37e535c29793c896fb2523b9e2edd8))
* **cli:** use B1.3's state words on search's empty state and upload's lines ([03e5af3](https://github.com/dosu-ai/sessiondb/commit/03e5af34d437ddfb3fbac28f3b864a69099840a5))
* **cli:** warn when keychain = false hides a login kept in the keychain ([2b282bd](https://github.com/dosu-ai/sessiondb/commit/2b282bd37e2d224ffda9b0ce2328eb62dc4a0aaf))
* **codex:** know seshi's notify by its hook words, not the first word's name ([df42f32](https://github.com/dosu-ai/sessiondb/commit/df42f32feea4645c1f6bc1f63a2068db73d507ab))
* **config:** filter the example Datadog source on Trajectory's ml_app ([b664f83](https://github.com/dosu-ai/sessiondb/commit/b664f83340f29bbb401a6b7f381a315db8ceb998))
* **config:** keep the decision step's key away from a redactor's own endpoint ([92e40c9](https://github.com/dosu-ai/sessiondb/commit/92e40c959fa4221fae5e8e54b37186d26c98bf2f))
* **config:** leave the decision model room for its thinking (4096 tokens) ([e2e4e77](https://github.com/dosu-ai/sessiondb/commit/e2e4e7715fd30b9a7b7edd1722b0368d4961950b))
* **config:** point .env.example's file:// store at the volume compose mounts ([07d58d1](https://github.com/dosu-ai/sessiondb/commit/07d58d1fc5c97e7252d733c79856e853a338ddaf))
* **config:** resolve . and .. before refusing a folder source in seshi's own store ([82fda01](https://github.com/dosu-ai/sessiondb/commit/82fda015379f939716080910582274f04b326b34))
* **config:** skip SESHI_* variables a secret reads, and name --set flags by path ([24e8df2](https://github.com/dosu-ai/sessiondb/commit/24e8df2b540bb942f9e18f4a08af2e38be6b7ccb))
* **config:** source ids may not hold -- or start or end with - ([f24963e](https://github.com/dosu-ai/sessiondb/commit/f24963efebaeae62fb51cee026af0e0be8bc0132))
* **config:** warn that owner visibility is not enforced in a mixed deployment ([cb92e45](https://github.com/dosu-ai/sessiondb/commit/cb92e45b024f3fba427fd5398607fe6c36bb6776))
* **config:** warn that server.public_url does nothing ([33e13ec](https://github.com/dosu-ai/sessiondb/commit/33e13ecea7a451188c86c58bf9ebddf0a8174f48))
* **cursor:** find Cursor 3's transcripts, which sit in a folder per conversation ([c9282a3](https://github.com/dosu-ai/sessiondb/commit/c9282a3836d37c6333a549f473109d8e768ebbc6))
* **cursor:** the extension finds seshi in hooks.json, not another tool's hook ([b536af9](https://github.com/dosu-ai/sessiondb/commit/b536af94933b0ee6f1b7dd0f8e132f0dcdeac3a4))
* **datadog-trajectory:** keep the Datadog keys from following redirects, time out hung requests ([730f73a](https://github.com/dosu-ai/sessiondb/commit/730f73a16c406e23e6cc3c13cf303d039892e205))
* **datadog-trajectory:** refuse a plain-http api_url outside this machine ([07f3667](https://github.com/dosu-ai/sessiondb/commit/07f36672f8df6c79453a6f222ccc7113da019547))
* **datadog:** never rewind a checkpoint forward past unread spans ([835611b](https://github.com/dosu-ai/sessiondb/commit/835611b45b7f0e9945df527cfd27e978115c027c))
* **docs:** give config check's exit code for an unusable config as 3 ([b50d770](https://github.com/dosu-ai/sessiondb/commit/b50d770041e078e401807abfefc0289536576b12))
* **docs:** say in SECURITY.md that a static token deletes its owner's sessions ([4d2d9c2](https://github.com/dosu-ai/sessiondb/commit/4d2d9c2bae265a6845522fb443c1460260d71694))
* **doctor:** a lost answer before a pause is a warning, not a failure ([ce79fe1](https://github.com/dosu-ai/sessiondb/commit/ce79fe10b9f06b829d215f23de1e6bb4317ebb55))
* **doctor:** recognise a stub after a resend answered unchanged ([965d854](https://github.com/dosu-ai/sessiondb/commit/965d854ff16a7968d6456d9b5fd5a97408923099))
* **doctor:** skip records when the server holds a piece with no answer ([32733ff](https://github.com/dosu-ai/sessiondb/commit/32733ff24ddf2706d00414a2bb6f4af6a5f1fef2))
* **doctor:** skip the prefix check after a redaction backfill ([e2ad2a0](https://github.com/dosu-ai/sessiondb/commit/e2ad2a0d46e02d437883959bee00fd2deec64f78))
* **doctor:** skip the prefix when a stub's dropped start no longer hashes as it did ([d85405c](https://github.com/dosu-ai/sessiondb/commit/d85405c067d17025b668b8b649ca63a3947cb040))
* **doctor:** skip the prefix when the stored records keep an earlier rule's markers ([935e041](https://github.com/dosu-ai/sessiondb/commit/935e0417aa722a2b3483299492d84a9d771fa14f))
* **doctor:** warn, not fail, while a replace review dropped waits ([20891a1](https://github.com/dosu-ai/sessiondb/commit/20891a1b2314fd903f65f4662c127ac860def8c8))
* **formats,api:** bound parent walks and keep history keys ([c83fd97](https://github.com/dosu-ai/sessiondb/commit/c83fd9708f6a4a836a7c9efd06da623bba2c00f9))
* **formats:** an OTLP export read as a log names no LLM calls ([2822e50](https://github.com/dosu-ai/sessiondb/commit/2822e50b71663bbcc83ea2cd2a9b19fd683970f9))
* **formats:** collect flattened tool calls by index in a Map ([a14a28a](https://github.com/dosu-ai/sessiondb/commit/a14a28af476b8209f418e1643360ddf47226c929))
* **formats:** keep token usage and the model of each turn from Claude Code and Codex logs ([2f60fc3](https://github.com/dosu-ai/sessiondb/commit/2f60fc35c7b102cf26e00f8997db0d4367113ad8))
* **formats:** label injected records from one canonical run, in one pass ([53fe6a9](https://github.com/dosu-ai/sessiondb/commit/53fe6a99a62c3798dfec82717a5b4ae2e6146330))
* **install:** glibc systems with musl installed, relative --dir, failed upgrade on Windows ([0f3ccd1](https://github.com/dosu-ai/sessiondb/commit/0f3ccd145f27cd056b02849ffd6875875d9a856e))
* **install:** run install.ps1 in a child scope so `iex` leaves the session alone ([d2f48f7](https://github.com/dosu-ai/sessiondb/commit/d2f48f79cb573afd9672a325ecdb34b44778d0bc))
* **instance:** read-only commands refuse a bucket no server has used ([498e10c](https://github.com/dosu-ai/sessiondb/commit/498e10cc75ee48634c994778b575c06f99343e2b))
* **instance:** run the span assembler once from cron with seshi sync assemble ([6710019](https://github.com/dosu-ai/sessiondb/commit/67100194da47f481604220557bcb0fd609e8502e))
* **kit:** expand ~ with the platform's path separator ([346a58e](https://github.com/dosu-ai/sessiondb/commit/346a58e180e3810d76dd730922cc6f4f7a505eec))
* **kit:** write Windows program paths so sh splits hook commands right ([8e54376](https://github.com/dosu-ai/sessiondb/commit/8e54376bfec0ce91dab6919dbc6d800767f18591))
* **model:** hold LLM calls to the trace contract ([b6d5832](https://github.com/dosu-ai/sessiondb/commit/b6d5832a530e1a196dd30e32398e1f039bd1e07b))
* **pipeline:** a chunk continuing a stub takes the current format version ([4db506f](https://github.com/dosu-ai/sessiondb/commit/4db506f450db07a4f5ed5fecb0ff83ac5dbc56a8))
* **pipeline:** a chunk that raced a backfill plans again ([74c90c7](https://github.com/dosu-ai/sessiondb/commit/74c90c796f2a3bf912ac1fc2f8c8d8b354ab3cb4))
* **pipeline:** a replace starts applied envelopes and redaction counts over ([0f248d8](https://github.com/dosu-ai/sessiondb/commit/0f248d82a5abb9369460dd9ac28148743474fe31))
* **pipeline:** backfill keeps a fork's continuation and redacts LLM calls ([6fb1311](https://github.com/dosu-ai/sessiondb/commit/6fb13113818440d993c5cdf4e5618d7cac5753f1))
* **pipeline:** bound idempotency keys ([0f45ea5](https://github.com/dosu-ai/sessiondb/commit/0f45ea5c5da65a4cc88b96995a33368df09de1dc))
* **pipeline:** keep a replaced span message a late span still names ([1ab1206](https://github.com/dosu-ai/sessiondb/commit/1ab1206b627f7ffb0bf9f8b2bd40d7e6063228fc))
* **pipeline:** keep quoted data out of failure records ([e5159e3](https://github.com/dosu-ai/sessiondb/commit/e5159e3f8a5320c20a58538e3af73911a362d9e7))
* **pipeline:** keep the drops in applied when a backfill rewrites a session ([c188734](https://github.com/dosu-ai/sessiondb/commit/c18873454283ece1fb37b0903667c69e3851e441))
* **pipeline:** keep the stored log state when review drops a replace ([3d06695](https://github.com/dosu-ai/sessiondb/commit/3d06695a3813394ab0cc4ebd86f2f436f7fe2db7))
* **pipeline:** leave a stub with a trace as it is when a replace ends in the dropped start ([7602b04](https://github.com/dosu-ai/sessiondb/commit/7602b043335ba902ead4b576b70af18d58f65899))
* **pipeline:** leave out spans whose ids are not OTLP hex ([05f88ce](https://github.com/dosu-ai/sessiondb/commit/05f88ce75bcdc37ea75e0940191549f1800f5b73))
* **pipeline:** let a replace rewrite a trace object that keeps its content hash ([cf96627](https://github.com/dosu-ai/sessiondb/commit/cf96627cd88284aa33c8c295306924cf9abb778b))
* **pipeline:** let tombstone delete a never-published session's span records ([ae3c536](https://github.com/dosu-ai/sessiondb/commit/ae3c536eafc28e499b028d82246eca364c4234fa))
* **pipeline:** list sessions past their span records ([9fa00ae](https://github.com/dosu-ai/sessiondb/commit/9fa00aebf2c5359a730730888c9ede17a4700afa))
* **pipeline:** never filter a tail that continues a stored head, and ignore shipped before one ([ac494a7](https://github.com/dosu-ai/sessiondb/commit/ac494a701dc407687abff7af1fe1b70da9a756e3))
* **pipeline:** record an assembled session's permanent failure ([b792310](https://github.com/dosu-ai/sessiondb/commit/b79231040b6eafe8b626c727c610d94a08c1efc8))
* **pipeline:** record each trace's rule set so backfill redoes sessions a new-rules chunk touched ([3df10ac](https://github.com/dosu-ai/sessiondb/commit/3df10ac579ad6744b915ba4baa789cbf04754a7c))
* **pipeline:** redact the span records of sessions never published in backfill ([590fd7f](https://github.com/dosu-ai/sessiondb/commit/590fd7f7c6d09215027c8f47e13b750566c26edd))
* **pipeline:** redact what LLM calls say before they are stored ([744c98c](https://github.com/dosu-ai/sessiondb/commit/744c98c496c167dc6c6dd2e008276c9225003eff))
* **pipeline:** refuse an unknown agent before storeSession writes ([0e89315](https://github.com/dosu-ai/sessiondb/commit/0e89315d3716728aed89c0e2687570d10d12c33f))
* **pipeline:** remove a raw part stored while the session was tombstoned ([ad82e18](https://github.com/dosu-ai/sessiondb/commit/ad82e1898e19c87de5fc456c92f20b98f761b34d))
* **pipeline:** remove a tombstoned session's traces when its pointer write was retried ([73423f2](https://github.com/dosu-ai/sessiondb/commit/73423f21cb5e8c9bc4914afd14711936dd6e84a0))
* **pipeline:** remove a trace published while the session was tombstoned ([547959d](https://github.com/dosu-ai/sessiondb/commit/547959d64195eea647442c4d5679d5f5c48342b0))
* **pipeline:** set a session's retraction hash only when its pointer is created ([585e3e5](https://github.com/dosu-ai/sessiondb/commit/585e3e5a6d7dab5600c3d18523e04982d4e3acd4))
* **pipeline:** the reviewer never sees the raw payload ([a850792](https://github.com/dosu-ai/sessiondb/commit/a850792d06fa62fa5621e9149ff3e8691eb80437))
* **redact:** a built-in match whose secret is already a marker counts nothing ([4890131](https://github.com/dosu-ai/sessiondb/commit/48901317f77d19b673f3c9a3cf93ab4b0f080473))
* **redact:** a client ignores disables of built-in rules it does not have ([6edcf51](https://github.com/dosu-ai/sessiondb/commit/6edcf516c6a20c221c13e05e300ddb8f9f45344b))
* **redact:** find sk- keys and URL credentials in linear time ([0253a90](https://github.com/dosu-ai/sessiondb/commit/0253a90e4d20898875e8435778075b3f68be5c69))
* **redact:** make the labeled-line separator unambiguous ([bfef13e](https://github.com/dosu-ai/sessiondb/commit/bfef13e13c3213c09d9ea41b142272bbb9a568da))
* **redact:** match sensitive-file globs in linear time instead of backtracking RegExp ([bc169b7](https://github.com/dosu-ai/sessiondb/commit/bc169b711d3b6a9d4d00abe8a6c0e38af8f22860))
* **redact:** pre-redact a tool call's input whole, as the server redacts its args ([7854da0](https://github.com/dosu-ai/sessiondb/commit/7854da09a82e745b22191ae8c870a1418043f7d5))
* **redact:** pre-redaction leaves the branch and source as the server does ([70ff6df](https://github.com/dosu-ai/sessiondb/commit/70ff6df6d4f3a7e528408db112714930412f0259))
* **release:** bound only the server's readiness by the smoke test's short wait ([dd75534](https://github.com/dosu-ai/sessiondb/commit/dd755347e4443de48e65dc0a9f786f75224684eb))
* **release:** check:hook times the hook without the caller's SESHI_* variables ([aa59e7d](https://github.com/dosu-ai/sessiondb/commit/aa59e7d2d32c0756a2ae1c1573f5b1b3f60bb5b3))
* **release:** published declarations resolve under NodeNext ([1d279a0](https://github.com/dosu-ai/sessiondb/commit/1d279a0ce9c31b3420fa380a6c92b0a40210a9af))
* **release:** re-sign darwin binaries ad hoc so codesign accepts the x64 build ([374b663](https://github.com/dosu-ai/sessiondb/commit/374b66359e2e483140e2486c183e498ec8a6fa54))
* **release:** smoke test fails fast on a stuck server; host check keeps the environment ([5a140e9](https://github.com/dosu-ai/sessiondb/commit/5a140e96b4da80e46cff50d8aaee5eb843b2e865))
* **review:** never let the Anthropic SDK log request bodies ([eb3824c](https://github.com/dosu-ai/sessiondb/commit/eb3824c4c5dc93052fdde0e9baa041e21ff00775))
* **review:** ship the eval fixtures from src/ so the image builds from source ([36790f7](https://github.com/dosu-ai/sessiondb/commit/36790f71733a57bbcdbf53ecfe79df2808446f20))
* **search:** keep the index right under clock skew, bad objects and rebuilds ([8744493](https://github.com/dosu-ai/sessiondb/commit/8744493a1923204b30b6fae47cc1c5feec454379))
* **search:** keep the snippet query's id list out of FTS5 ([3d0aa20](https://github.com/dosu-ai/sessiondb/commit/3d0aa206d886511c6819efd38dc3b0a4c09e0b5d))
* **search:** review fixes for the cross-owner change feed ([2192582](https://github.com/dosu-ai/sessiondb/commit/2192582e3caca42a3c2faabc887207118a644ed5))
* **serve:** flush source health counters on shutdown ([2ef7929](https://github.com/dosu-ai/sessiondb/commit/2ef7929cb4356791abd7a53465bd18425daa57e0))
* **server:** show the review set, and keep a write's reviewer ([e649b6e](https://github.com/dosu-ai/sessiondb/commit/e649b6eebd9435f80c00827c75e0663974e485cf))
* **seshi:** a service uploader waits for the lock instead of exiting ([41abd1e](https://github.com/dosu-ai/sessiondb/commit/41abd1ef93bd85b3f7d6934d6bf523179378f3bb))
* **seshi:** healthcheck asks where serve listens, a mounted seshi.toml included ([3d97766](https://github.com/dosu-ai/sessiondb/commit/3d97766b4af4f67f72bb3dd13467616480268443))
* **seshi:** login --visibility only with an IdP; whoami names the stated username ([45db5ab](https://github.com/dosu-ai/sessiondb/commit/45db5ab713d506dc21aa4bd1aa20c11e52b5a94a))
* **seshi:** make the bin entry point executable ([b46e7ec](https://github.com/dosu-ai/sessiondb/commit/b46e7ec939b817c6ceb031f0a43b7d5cdf88fe2d))
* **seshi:** print other people's text without its control characters ([1abc901](https://github.com/dosu-ai/sessiondb/commit/1abc90142d07b966836a23618b9fff9cb46e5d20))
* **seshi:** report files the CLI cannot read or write instead of crashing ([14f624c](https://github.com/dosu-ai/sessiondb/commit/14f624c9b757be18e9da515287d29145fcb70e31))
* **seshi:** serve lets requests in flight finish when it stops ([dedf5db](https://github.com/dosu-ai/sessiondb/commit/dedf5dbd88ce4d9c134318f2b3712c99a5d7dd3a))
* **seshi:** serve says why it cannot listen, and one-shot commands close their instance ([b9cb424](https://github.com/dosu-ai/sessiondb/commit/b9cb4244ca0ebbb8f3e44278815b24ae9c029450))
* **seshi:** sessions rm asks before it renews the session token ([ca0a96f](https://github.com/dosu-ai/sessiondb/commit/ca0a96f62dcbc00164406cb73d7b132a5c672d13))
* **seshi:** sync failed and dropped read a source no longer in [[sources]] ([a4b9ddb](https://github.com/dosu-ai/sessiondb/commit/a4b9ddbe8f1f7168e17fb65adfd6f5a3f98a0e87))
* **seshi:** turning a session back on calls off a refused retraction too ([290e570](https://github.com/dosu-ai/sessiondb/commit/290e570894950d82bcc04b674764bfff632ef8f3))
* **sources,store:** unzip gzip-encoded source objects with a limit ([f36cf71](https://github.com/dosu-ai/sessiondb/commit/f36cf71262a780c13c1cc590a3ae4ea181283ad8))
* **sources:** keep the checkpoint behind a transient failure, and end a run's context with it ([d322b6c](https://github.com/dosu-ai/sessiondb/commit/d322b6c6ab02a8e8c8cb5cfdcdbcfeafd042853e))
* **sources:** one object the bucket can never serve no longer stalls an S3 source ([adf84cf](https://github.com/dosu-ai/sessiondb/commit/adf84cf814fb72f139f97e560cdb6a46eae69757))
* **sources:** reprocess reads S3 objects again instead of replaying them (X4.9) ([f64491f](https://github.com/dosu-ai/sessiondb/commit/f64491fe65b0726628f9f57b93435441e891764f))
* **spec:** describe metadata retract_hash as live, not reserved ([a683e4d](https://github.com/dosu-ai/sessiondb/commit/a683e4d0c3382f344dd9569fe7ad05bbe5c69e38))
* **spec:** name seshi, ATIF-v1.8 input and the OTLP body bound in openapi.yaml ([51d076f](https://github.com/dosu-ai/sessiondb/commit/51d076f7de9f89dab9e8342f536935dacddcaab9))
* **store:** create the folder store owner-only ([4c1c4df](https://github.com/dosu-ai/sessiondb/commit/4c1c4df0dccc3f379dc1b687d2e11f29b723310a))
* **store:** create trace objects with If-None-Match ([13325d0](https://github.com/dosu-ai/sessiondb/commit/13325d0b87c5a0bafda53339f08f9c7924b4c788))
* **store:** give every pending-marker touch its own ETag ([6845056](https://github.com/dosu-ai/sessiondb/commit/684505645b1ecf5b69e12a8dc77cec9036a61682))
* **store:** keep a trace object a publish reuses out of the sweep ([1c3c963](https://github.com/dosu-ai/sessiondb/commit/1c3c963714bff5d5161fdb8dba39a5c641989c61))
* **store:** read S3's 404 on an If-Match PUT as PreconditionFailed ([fb0da0b](https://github.com/dosu-ai/sessiondb/commit/fb0da0ba8c63e6f6e96265faef6836dd3a9ca830))
* **store:** take over stale folder locks atomically and release only our own ([463027b](https://github.com/dosu-ai/sessiondb/commit/463027b4bc17bb44ea3987436dee9abfbba47ca9))
* **verify-seshi:** clean up a failed up; pin the local-mode owner ([7d182a6](https://github.com/dosu-ai/sessiondb/commit/7d182a6f26a1d8b12f3487c2d025c06f103d8f98))
* **verify-seshi:** set local mode up with seshi init --serverless ([26c6f5c](https://github.com/dosu-ai/sessiondb/commit/26c6f5c3ceb6a56ede9a236939cf3db15c6dcaa5))


### Features

* **api:** admin source routes for sync status, failed and dropped over HTTP ([115a09e](https://github.com/dosu-ai/sessiondb/commit/115a09ec6972092be7c899ce4bee482c02de8ac6))
* **api:** cap OTLP bodies at 64 MiB sent and 256 MiB inflated ([ce330b1](https://github.com/dosu-ai/sessiondb/commit/ce330b14ac78607637ce3306cf3bb7cf1e228f3d))
* **api:** GET /v1/redaction/rules serves the org's packs to clients (F2.4) ([058db7e](https://github.com/dosu-ai/sessiondb/commit/058db7e33888c02a273c9373ee6fd351a2cb2383))
* **api:** GET /v1/search with the search scope and visibility enforced ([c79e2ca](https://github.com/dosu-ai/sessiondb/commit/c79e2ca921638da0fd5df46e806cfa3af7808104))
* **api:** GET /v1/sessions/:agent/:session_id/reviews ([93eb1dd](https://github.com/dosu-ai/sessiondb/commit/93eb1dd67e2473059bc9610628c9c0680da55634))
* **api:** one change feed across all owners (GET /v1/changes/all) ([ac9ebf1](https://github.com/dosu-ai/sessiondb/commit/ac9ebf1d3c6b1af53941801095021b3d31cacbd8))
* **api:** POST /otlp/v1/traces, the OTLP/HTTP trace receiver ([de1cd95](https://github.com/dosu-ai/sessiondb/commit/de1cd9529dff475d606ddb2efe31b2eac0a660a4))
* **api:** retraction with a per-session secret (F9.7) ([d256b04](https://github.com/dosu-ai/sessiondb/commit/d256b04e5ed74cfae2e2658c7ffa003d628a1086))
* **api:** the routes take an Instance, and seshi serve builds one ([ed785dc](https://github.com/dosu-ai/sessiondb/commit/ed785dca81fa7538e6171f0d391e8577b3ce1aeb))
* **api:** uploads go through the pipeline as envelopes ([34e03c1](https://github.com/dosu-ai/sessiondb/commit/34e03c10f40a41e38253563793855f8db9283f3a))
* **auth:** seshi tokens, the org key, IdP sign-in, scopes, roles and visibility (X5) ([7983ac6](https://github.com/dosu-ai/sessiondb/commit/7983ac64c54c2a73838a6b90cc6436d6d302eb4d))
* **brand:** outlined lockups and the npm badge (B1.5) ([05eadf1](https://github.com/dosu-ai/sessiondb/commit/05eadf152838d3e39ba9c73c7b938934ea105a85))
* **capture:** /seshi off|on|status in Cursor, done by seshi's own hook ([7967b51](https://github.com/dosu-ai/sessiondb/commit/7967b51c8c7cdcfa32c749bee5e4739c97451603))
* **capture:** a Codex session-start notice that says whether the session is captured ([b2a0554](https://github.com/dosu-ai/sessiondb/commit/b2a055427cba688a0a7513937f912b0b03e4b96d))
* **capture:** capture Cursor Cloud agents through hooks committed to the repository ([80dd196](https://github.com/dosu-ai/sessiondb/commit/80dd196c55639df47d4fc0391e872a1eb9db0cc2))
* **capture:** capture OpenCode 2.x sessions ([d1f0e5b](https://github.com/dosu-ai/sessiondb/commit/d1f0e5b1ffdcfa0fbee4e3994650836564ff33cc))
* **capture:** chain an existing Claude Code status line; a seshi skill for Codex and Cursor ([dc4aff6](https://github.com/dosu-ai/sessiondb/commit/dc4aff6eee9594b2e9acc22c021d9ea729479476))
* **capture:** Codex's $seshi off|on|status is done by seshi's own hook, outside the sandbox ([ea36cf7](https://github.com/dosu-ai/sessiondb/commit/ea36cf7f7810e2a6f9c87efadb6a4dcd02cd9b99))
* **capture:** live capture for pi and OpenCode ([e9613b9](https://github.com/dosu-ai/sessiondb/commit/e9613b9ef4bd5b9e8b2d2a545b2b95f072aa8f31))
* **capture:** OpenCode TUI plugin for the status and /seshi ([dbe8865](https://github.com/dosu-ai/sessiondb/commit/dbe8865a083bf9c88e313d4ec7756f1a61d9219f))
* **capture:** resend stale sessions whole with rebuild ([587a5b8](https://github.com/dosu-ai/sessiondb/commit/587a5b8b748c09949d0648707406afb1e91e81b5))
* **capture:** seshi statusline can tell an editor which conversation it is on ([a08588e](https://github.com/dosu-ai/sessiondb/commit/a08588ee586ce5dd1ad45bbedbfa234a72060565))
* **capture:** spool, uploader, sweep, capture rules and state (F9.1-F9.5, F9.7) ([3e12cb6](https://github.com/dosu-ai/sessiondb/commit/3e12cb64dc93ea3854163756d99dd42cb26357e5))
* **capture:** spread stale rebuilds over a day, at most two a pass ([32e3f28](https://github.com/dosu-ai/sessiondb/commit/32e3f2820d8e33422406fd830bc26be75136dda3))
* **capture:** stop sessions where they are on pause; keep the uploader up while retries wait ([1e505dd](https://github.com/dosu-ai/sessiondb/commit/1e505dde21cda638fd8c368e5a18df9bb19a7078))
* **capture:** sweep OpenCode sessions from its own database ([9d4642e](https://github.com/dosu-ai/sessiondb/commit/9d4642e865eb674c66fe95421e13e9927a59088a))
* **capture:** the Cursor CLI's status line shows Session Capture ([90bf55b](https://github.com/dosu-ai/sessiondb/commit/90bf55b35149ce2ddde5152f26d1e0a813d03274))
* **capture:** wire client pre-redaction and drop the last stubs now that 07 and 12 are in the stack ([9bd6cd1](https://github.com/dosu-ai/sessiondb/commit/9bd6cd179e37d2808fe09f591b24d865ce6fe7d7))
* **claude-code:** the desktop Session Capture chip and /session-capture (F9.4–F9.6) ([51a60da](https://github.com/dosu-ai/sessiondb/commit/51a60da2113affe6264c07029f5a43df4fc49142)), closes [dosu-ai/dosu#13997](https://github.com/dosu-ai/dosu/issues/13997)
* **claude-platform:** anthropic.* attributes for the otlp-genai format ([3656c2e](https://github.com/dosu-ai/sessiondb/commit/3656c2e94501d2ac5b51db3fb01efc2999cc5525))
* **cli:** add seshi capture resend [--all | --session <id>] ([e0ea928](https://github.com/dosu-ai/sessiondb/commit/e0ea92879ec3094aff9e18cb93f5e9dcd0958766))
* **cli:** add seshi doctor ([ad986bc](https://github.com/dosu-ai/sessiondb/commit/ad986bc88406c51fef050fad0ef9161a6dce3622))
* **cli:** add seshi redact sweep, and report backfill's sweep ([803e474](https://github.com/dosu-ai/sessiondb/commit/803e4742240d347adc1d6d6f76dc6a9ebde060b4))
* **client:** name the published package in the default User-Agent ([cc50eb2](https://github.com/dosu-ai/sessiondb/commit/cc50eb2904be306bf7bcf550f004dd20db5ef8b3))
* **client:** owner-aware reads, visibility, tokens, admin status and sign-in calls ([0d6b4a7](https://github.com/dosu-ai/sessiondb/commit/0d6b4a7c1f9ccf9f8bb4254861c7a538e3f968d3))
* **cli:** seshi explore, a local read-only web page for sessions ([189b9ca](https://github.com/dosu-ai/sessiondb/commit/189b9ca0a2121fe7270210bd8249a6ee2307e8c1))
* **cli:** seshi review eval scores a policy against labelled fixtures ([a6df069](https://github.com/dosu-ai/sessiondb/commit/a6df069618f30c9ddc583938c91e62dd835cb06f))
* **cli:** sessions ls folds subagents, dates by last activity, names the repo ([5384754](https://github.com/dosu-ai/sessiondb/commit/53847541448d56c5f19ea8e0e6fb5e1aa1dec5c7))
* **config:** keychain = false keeps CLI credentials in the 0600 file ([2fd3d76](https://github.com/dosu-ai/sessiondb/commit/2fd3d769b0a0276f9bd05f5b48b9408101fcc48f))
* **config:** max_upload_bytes caps the transcript as sent ([d12a71f](https://github.com/dosu-ai/sessiondb/commit/d12a71ffc47f140c70eb688f95b0025af3460603))
* **config:** refine the datadog source for the LLM Observability poller ([33786db](https://github.com/dosu-ai/sessiondb/commit/33786dbd581ab08805955e92d50568df8792728b))
* **config:** review policies with defaults, inheritance and a required provider key ([0a86107](https://github.com/dosu-ai/sessiondb/commit/0a8610714f68a4f7827e467ec7ec238b473b8375))
* **config:** s3 source path template; folder sources may not read seshi's own ([fc67958](https://github.com/dosu-ai/sessiondb/commit/fc67958d7c1a608f8f85dd62007191ec9d1c762b))
* **config:** search settings and the search API types ([acf7a3d](https://github.com/dosu-ai/sessiondb/commit/acf7a3d8af554cf72777a53081074e3c57240623))
* **config:** server.instance_id, records.health_retention and the CLI's local mode ([8a718a4](https://github.com/dosu-ai/sessiondb/commit/8a718a4be1fdca2aa856b3274641e7c61cd6273f))
* **config:** the org capture rule and capture's own SESHI_ variables (F9.5) ([22eadf8](https://github.com/dosu-ai/sessiondb/commit/22eadf82c16e221dd51f96ee98517d351962afea))
* **config:** TOML and SESHI_* env loader with one strict schema, provenance and secret references ([6d04e06](https://github.com/dosu-ai/sessiondb/commit/6d04e06a824aa73496af3ce1387779fb6eb65e89))
* **cursor:** a Cursor extension that shows Session Capture in the status bar ([3b25187](https://github.com/dosu-ai/sessiondb/commit/3b25187b8e1c2025c004d9d3a429858a105b31b0))
* **cursor:** a shorter tooltip: on or off for the chat, its title, and "Click to toggle" ([d59dc9e](https://github.com/dosu-ai/sessiondb/commit/d59dc9ef88a5b9b442c0610aa15657125ac99ed8))
* **cursor:** shorter hint in the tooltip: (last messaged 2 min ago) ([98178d4](https://github.com/dosu-ai/sessiondb/commit/98178d45729fdfbd153e9bb335297aa33e4f52aa))
* **datadog-trajectory:** datadog-llmobs span format for Trajectory turns ([57f18fe](https://github.com/dosu-ai/sessiondb/commit/57f18fe9b2a4c6d02d5c26c5dedeb1f7fcba2d13))
* **datadog-trajectory:** Export API client pinned to the documented shape ([006649c](https://github.com/dosu-ai/sessiondb/commit/006649ca128c3b3b0e0e5989ece19ebde2bc2b73))
* **datadog-trajectory:** poll Datadog LLM Observability for datadog sources ([75527a2](https://github.com/dosu-ai/sessiondb/commit/75527a2c9db4f6458830e59125bcd142780d2eaf))
* **datadog-trajectory:** wire ctx.fail and the sources docs now that S3 sync is in the stack ([b550cf7](https://github.com/dosu-ai/sessiondb/commit/b550cf7824a90700c8fd5ce3e635ead40b24d556))
* **datadog-trajectory:** wire redaction and review checks for datadog sessions now that 07 and 08 are in the stack ([604930c](https://github.com/dosu-ai/sessiondb/commit/604930c9af6149a87f0757b413feff630fb8469e))
* **doctor:** gather a session's evidence and check it ([bb268d5](https://github.com/dosu-ai/sessiondb/commit/bb268d512a10182ebf98aefabdbfa70e8498ef5e))
* **explore:** a read-only API and server over the doctor's engine ([7c11fec](https://github.com/dosu-ai/sessiondb/commit/7c11fecb1c5840718876479ddf6233e10b860b24))
* **explore:** the page, vanilla TypeScript bundled from an HTML import ([19f6c08](https://github.com/dosu-ai/sessiondb/commit/19f6c08b2aeee435faa55cda549443ea7889f0f2))
* **formats:** honour session_capture.omit on injected content, label synthetic user records ([2c46c9e](https://github.com/dosu-ai/sessiondb/commit/2c46c9e436e394b5b8dc13a07e80e64f0d7b188f))
* **formats:** otlp-genai span format by the OTel GenAI conventions ([5d23281](https://github.com/dosu-ai/sessiondb/commit/5d232811d40cfe2b359066a7a918606dc22097fe))
* **formats:** render the canonical trace as Letta, OTLP and ATIF on read (X6.2) ([12cb10f](https://github.com/dosu-ai/sessiondb/commit/12cb10fc76122dce793a71dcae0f4663ba3c19a9))
* **install:** install.sh and install.ps1 ([860b241](https://github.com/dosu-ai/sessiondb/commit/860b241d51e55144d04b33b75a2ab4de8bdb4057))
* **instance,config:** the span assembler as a worker job ([4793bc1](https://github.com/dosu-ai/sessiondb/commit/4793bc10f94b1ebebec80dd16856d2434e00702e))
* **instance:** a search service per instance and the indexer job ([5c50304](https://github.com/dosu-ai/sessiondb/commit/5c50304d442249ab165dd5047995cf401f54e68b))
* **instance:** an Instance from one config, with worker jobs and job status ([e9225c3](https://github.com/dosu-ai/sessiondb/commit/e9225c3e2f057a353a76d66c13244ba40734e8b2))
* **instance:** build the reviewer from [review] ([4dcf88d](https://github.com/dosu-ai/sessiondb/commit/4dcf88dc749cba5de0397a93ae7a10ac6040bced))
* **instance:** every instance polls s3 sources with the built-in poller ([9f9e5f8](https://github.com/dosu-ai/sessiondb/commit/9f9e5f8023da313fcbd96061cc48cc285769362c))
* **instance:** read redaction packs into the Instance's rule set ([c5edb91](https://github.com/dosu-ai/sessiondb/commit/c5edb91988752372204b609a12466f88cb59c69e))
* **instance:** retry a failed job with backoff (X4.8) ([4f209d4](https://github.com/dosu-ai/sessiondb/commit/4f209d46522e05109d198959923cc8b571100fc6))
* **instance:** run the sweep daily on the worker ([3c2ca53](https://github.com/dosu-ai/sessiondb/commit/3c2ca53ef51d68641b7f1ca99b4302d685812abc))
* **integrations:** capture for Claude Code, Codex and Cursor (F9.2, F9.6) ([c665a88](https://github.com/dosu-ai/sessiondb/commit/c665a88fc8f248ab07fd7de9d95e131f11595547))
* **kit,sources:** connectors record failures that never became envelopes ([1122389](https://github.com/dosu-ai/sessiondb/commit/1122389835a908ffdd48621da43162ac4a560c66))
* **kit,store:** the connector contract, checkpoint removal, health pruning and job records ([8507303](https://github.com/dosu-ai/sessiondb/commit/85073035df41f33a70dd12f904f7e02332d76ed7))
* **kit:** a span submission says how many spans were left out ([77f198e](https://github.com/dosu-ai/sessiondb/commit/77f198ea9a7739165f52e7c5b8ba4b4b2b349d19))
* **kit:** the capture contract: CaptureAgent, HookHandler, Installer (F9, X3.11) ([50e2ead](https://github.com/dosu-ai/sessiondb/commit/50e2eadcbd072a8d9f2b55bf7b99f6c517baec21))
* **model,kit:** span set contract for the span assembler ([4e4566f](https://github.com/dosu-ai/sessiondb/commit/4e4566f27047cd836445a0ad882ec4ef42622d7f))
* **model:** canonical seshi/trace/1 and the seshi metadata and change entries (X6.2, X5.5) ([b6c3e54](https://github.com/dosu-ai/sessiondb/commit/b6c3e54e47ac67eb92c03743c8882024b5993ea8))
* **model:** check stored objects against spec/schemas at run time ([83cb3b9](https://github.com/dosu-ai/sessiondb/commit/83cb3b9ac823f40ed81756f829acc2f638570960))
* **pipeline:** carry review failures, unmatched findings and parts to the records ([57d6ad6](https://github.com/dosu-ai/sessiondb/commit/57d6ad6b8fee18f41ec8225e0e4704d6f0038b6b))
* **pipeline:** keep a dropped first envelope out of rebuilds and replaces ([7eb5e89](https://github.com/dosu-ai/sessiondb/commit/7eb5e898b58cac97d6cf7dc72a34636804c8ccd9))
* **pipeline:** keep a session stub when review drops its first envelope ([0d14da8](https://github.com/dosu-ai/sessiondb/commit/0d14da89549919fac4366f944d84614c6007bcab))
* **pipeline:** normalize with a rule set, and test counts on every stored session ([f902c6b](https://github.com/dosu-ai/sessiondb/commit/f902c6bd3c1b8211e497d27dee8bb200df24701d))
* **pipeline:** one envelope pipeline, decided in memory, no raw ([3a9119d](https://github.com/dosu-ai/sessiondb/commit/3a9119d0bcbc8dfd72f1d5bb2eb4c5c6363e5237))
* **pipeline:** record each session's format version, list stale sessions, add rebuild ([b66cea9](https://github.com/dosu-ai/sessiondb/commit/b66cea9dfc7294bb922d5a200eafc1dd58a421c7))
* **pipeline:** redaction backfill over stored sessions (F2.5) ([5cf9068](https://github.com/dosu-ai/sessiondb/commit/5cf906828bbbb1268a2d718d8bdfec4a6abb5c7a))
* **pipeline:** span store, span assembler and LLM call redaction ([591cb4c](https://github.com/dosu-ai/sessiondb/commit/591cb4c39b4304def40a8b1b32cdb6f884bdba7a))
* **pipeline:** sweep the sessions a backfill or replace touched ([0fa7a6a](https://github.com/dosu-ai/sessiondb/commit/0fa7a6a04d64970cbf54a5a6aeb2227d6152f27c))
* **pipeline:** take the session filter and size limits as options ([5467a30](https://github.com/dosu-ai/sessiondb/commit/5467a307171a738c3d9cf0c53db343c3d6d744ee))
* **pipeline:** the authorize contract, visibility and owner basis on writes ([909b0f9](https://github.com/dosu-ai/sessiondb/commit/909b0f92479187c9086fa66f28d283eb6463b113))
* **pipeline:** wire span and LLM call redaction, and review of assembled sessions, now that 07 and 08 are in the stack ([319bbf9](https://github.com/dosu-ai/sessiondb/commit/319bbf93cae0f74710cae6f4fc013afef77ee02e))
* **pipeline:** write canonical traces with conditional metadata updates and writers ([578a05b](https://github.com/dosu-ai/sessiondb/commit/578a05bee92cc181b962e20601015d83b24e60bc))
* **redact:** redact seshi tokens in transcripts ([7ab9f7a](https://github.com/dosu-ai/sessiondb/commit/7ab9f7a6b29e69b4435bcd578e3ab0c93a5de8de))
* **redact:** regex redaction over normalized records ([48ba528](https://github.com/dosu-ai/sessiondb/commit/48ba5288d3f017e050277fb93f73eb13baabe106))
* **redact:** TOML rule packs, RE2 for operator patterns, counts by rule id ([dfa9bef](https://github.com/dosu-ai/sessiondb/commit/dfa9bef5bb5b0a9fe2557fa222041b66224b2b5b))
* **release:** cross-compiled release archives with SHA256SUMS ([fcd8a63](https://github.com/dosu-ai/sessiondb/commit/fcd8a6396eb77c5f476b0759e687c70ff9b2bc3c))
* **release:** npm packages: the seshi launcher, platform binaries, model and client ([e049b28](https://github.com/dosu-ai/sessiondb/commit/e049b2837b61602cedfb1a8eeec7224362b4cf10))
* **release:** wire capture and redaction checks now that 14 and 07 are in the stack ([0407c36](https://github.com/dosu-ai/sessiondb/commit/0407c36a86943c334b9224dd0acc43f215ed8d7e))
* **review:** decision model and redactor LLM behind a provider interface ([cb92418](https://github.com/dosu-ai/sessiondb/commit/cb92418c0186d5fdca8213e96aa30b092a7ca98d))
* **review:** settle redaction backfill and review now that 07 is in the stack ([46393da](https://github.com/dosu-ai/sessiondb/commit/46393daed04563300a13ec7a17de092eadd286af))
* **search:** SQLite FTS5 index, change-feed indexer and query layer ([0a3be30](https://github.com/dosu-ai/sessiondb/commit/0a3be30fec122402f5117a9fa0d9dba18528211c))
* **search:** wire backfill replaces, OTLP and Datadog sessions now that 07, 09 and 10 are in the stack ([0bb991c](https://github.com/dosu-ai/sessiondb/commit/0bb991c7cb4fb5bdee3d77c02deb48d877a43525))
* **server:** reload config, sources and rule packs without a restart ([ed3ee11](https://github.com/dosu-ai/sessiondb/commit/ed3ee11a5271a8ddd4a7af461150b083e613e208))
* **server:** reload review prompt files ([5a6ea52](https://github.com/dosu-ai/sessiondb/commit/5a6ea521df3123cf26d2567fa4486b7a1def626d))
* seshi toolkit for session capture and storage ([edd5084](https://github.com/dosu-ai/sessiondb/commit/edd5084a30ff4bd0960f3d0d06cce5545c303f83))
* **seshi:** CLI colours from the brand tokens, --no-color and the terminal (B1.4) ([bf00ea6](https://github.com/dosu-ai/sessiondb/commit/bf00ea681d5ec307bde4d1523bf462e6fdc0715a))
* **seshi:** config check loads the redaction packs as serve does ([e62f9d0](https://github.com/dosu-ai/sessiondb/commit/e62f9d0c0460c5d4cb2229fda712eacbc1229fe3))
* **seshi:** configure serve from @seshi/config and add seshi config check|show ([9523b5f](https://github.com/dosu-ai/sessiondb/commit/9523b5f78939f9c7454356446ca955693c2d26d1))
* **seshi:** every F8.1 command group, and the worker and sync commands ([260a133](https://github.com/dosu-ai/sessiondb/commit/260a133602a1487a7d7593cc7ea56aa3ef7a3811))
* **seshi:** hook, statusline, daemon, capture and upload (F9, B1.6) ([cf55d2a](https://github.com/dosu-ai/sessiondb/commit/cf55d2a3836aea3ca22cc93b2562c68d84508643))
* **seshi:** local mode replaces the direct-to-bucket client (X3.5) ([57aa130](https://github.com/dosu-ai/sessiondb/commit/57aa1308d79def2b0bcbfce0f687c7308e73efd8))
* **seshi:** remote workers status and sync status|failed|dropped ([e73c780](https://github.com/dosu-ai/sessiondb/commit/e73c7800200f08bdb8924211f3157dea21dd5b64))
* **seshi:** seshi login, logout and whoami with keychain credentials (F8.2, X5.7) ([98cf853](https://github.com/dosu-ai/sessiondb/commit/98cf853f7d47826c3fded58eca67ce866801a78c))
* **seshi:** seshi redact test and seshi redact backfill ([79050bf](https://github.com/dosu-ai/sessiondb/commit/79050bfa35b315b79ec0606292159941f43b6fb7))
* **seshi:** seshi sessions ls|show|export|rm|visibility and seshi tokens (F8.1, F8.3) ([cc19d3c](https://github.com/dosu-ai/sessiondb/commit/cc19d3c6d46daf9b9ff95a16ee66556f4eee35c5))
* **seshi:** seshi store check, a read-only check of the bucket ([ad53c8b](https://github.com/dosu-ai/sessiondb/commit/ad53c8bd8cd3f30f4b6bff3e4bea09595639222c))
* **seshi:** the seshi search command ([a710a7b](https://github.com/dosu-ai/sessiondb/commit/a710a7b98d9e05453cb3beafc7e3b9ad953c5618))
* **seshi:** wire search, redact test and review labels now that 07, 08 and 12 are in the stack ([597f74b](https://github.com/dosu-ai/sessiondb/commit/597f74b096a656d1b700b75a4b58b8a129891872))
* **sources:** the connector scheduler and checkpoints ([79e09a6](https://github.com/dosu-ai/sessiondb/commit/79e09a644867019a091bdb3e8e662194f1726363))
* **sources:** the S3 poller (F6) ([ccc6984](https://github.com/dosu-ai/sessiondb/commit/ccc6984e7e26e32df29abcc0d37c6dca233d7867))
* **spec:** envelope, applied envelopes and replace in the contract; no raw parts ([b47afa4](https://github.com/dosu-ai/sessiondb/commit/b47afa4a447148d0f08a633a6541df437e3993a1))
* **store:** checkStore, a read-only checker of a bucket's invariants ([acd35f1](https://github.com/dosu-ai/sessiondb/commit/acd35f1a902924d8354f4c610ef507dbc133dc0c))
* **store:** conditional writes with ETags and read-modify-write retry (X6.5) ([2890fe5](https://github.com/dosu-ai/sessiondb/commit/2890fe5f1ec54a53fba054aa16f7051dffb367ee))
* **store:** owner ids from identity, owner listing, typed token records ([0e7815e](https://github.com/dosu-ai/sessiondb/commit/0e7815ef5816507a9c07b9a812ae033408974415))
* **store:** read side for pollers: object listings, ranged GET, STS ([0baebe4](https://github.com/dosu-ai/sessiondb/commit/0baebe4ac7df8db3ed47bfb67ca12ca93589d916))
* **store:** seshi layout marker, X6.4 keys and typed accessors, drop and failure records ([ceb9ba3](https://github.com/dosu-ai/sessiondb/commit/ceb9ba356c779ef2c0b6fe32c3661078d6b5e83d))
* **store:** source health counters, and no raw key ([fdd7e38](https://github.com/dosu-ai/sessiondb/commit/fdd7e38ee2f4b43e40ba2844164b962e0b70f85b))
* **store:** span records and pending-marker details ([05159ad](https://github.com/dosu-ai/sessiondb/commit/05159adefc5e07f960ea5ad2fb83d18893c8b9ac))
* **store:** store span input history once per session by content hash ([d9ab5fe](https://github.com/dosu-ai/sessiondb/commit/d9ab5fe0aef6d03f69b09a996e6aa4675d5cbecf))
* **store:** sweep trace objects no metadata names (F2.5) ([88bbbed](https://github.com/dosu-ai/sessiondb/commit/88bbbed943da350a3cb3d6856137277b68e17552))
* **store:** write change entries before the pointer, with unique keys ([346a7b3](https://github.com/dosu-ai/sessiondb/commit/346a7b3555b604d0e86ed1b45000388150dbe56c))
* **verify:** a verify-seshi skill that drives a real, isolated seshi with evidence ([bce4abc](https://github.com/dosu-ai/sessiondb/commit/bce4abc47e2b3797452ecf6fe341db5de68f9c7f))


### Performance Improvements

* **release:** the npm launcher skips the report's network section ([f0cfd4a](https://github.com/dosu-ai/sessiondb/commit/f0cfd4aadd38b4b2260e337531a5116721e8b74a))

# [0.9.0](https://github.com/dosu-ai/sessiondb/compare/v0.8.0...v0.9.0) (2026-11-12)


### Features

* **redact:** withhold sensitive tool results, and take an operator's own rules ([7245ed9](https://github.com/dosu-ai/sessiondb/commit/7245ed95cb01bbf5586d07cb670e802cf40d794d)), closes [dosu-ai/dosu-adx#10](https://github.com/dosu-ai/dosu-adx/issues/10) [#11](https://github.com/dosu-ai/sessiondb/issues/11)

# [0.8.0](https://github.com/dosu-ai/sessiondb/compare/v0.7.0...v0.8.0) (2026-11-12)


### Features

* **sdk:** choose the trace format, letta or otlp ([0e55071](https://github.com/dosu-ai/sessiondb/commit/0e55071898af93da1268f871689d56a240db1f24))

# [0.7.0](https://github.com/dosu-ai/sessiondb/compare/v0.6.0...v0.7.0) (2026-11-12)


### Features

* **sdk:** read ATIF-v1.8 documents ([b24c5e0](https://github.com/dosu-ai/sessiondb/commit/b24c5e0b19ddbe2c88755b03f82df7734ae49397))

# [0.6.0](https://github.com/dosu-ai/sessiondb/compare/v0.5.0...v0.6.0) (2026-11-12)


### Features

* **sdk:** detect a transcript's source; pass trajectory records through ([aa32eef](https://github.com/dosu-ai/sessiondb/commit/aa32eefee91cb929bfd56ceb8196e4a744c242ab))

# [0.5.0](https://github.com/dosu-ai/sessiondb/compare/v0.4.1...v0.5.0) (2026-11-10)


### Bug Fixes

* **sdk:** put ATIF tool errors on the records the adapter links ([628cf5f](https://github.com/dosu-ai/sessiondb/commit/628cf5ffcc30c21769be9a701f4fa85b584901c7))


### Features

* **sdk:** accept ATIF documents and keep the harness name ([77462ae](https://github.com/dosu-ai/sessiondb/commit/77462ae1d88e79cd454d2ab296d383185bb6401e))

## [0.4.1](https://github.com/dosu-ai/sessiondb/compare/v0.4.0...v0.4.1) (2026-11-09)


### Bug Fixes

* **server:** apply Debian security updates in the image ([87f1a04](https://github.com/dosu-ai/sessiondb/commit/87f1a046a26625315f401fc3189229496b2cd59d))

# [0.4.0](https://github.com/dosu-ai/sessiondb/compare/v0.3.0...v0.4.0) (2026-11-06)


### Features

* **store:** S3 and R2 under Node, over fetch with SigV4 signing ([4b363d5](https://github.com/dosu-ai/sessiondb/commit/4b363d519af174ffe8890743ba5e875148a7a8f5))

# [0.3.0](https://github.com/dosu-ai/sessiondb/compare/v0.2.1...v0.3.0) (2026-11-03)


### Features

* **server:** accept tokens signed with SESSIONDB_TOKEN_SECRET ([345ba95](https://github.com/dosu-ai/sessiondb/commit/345ba95bc2675544474936ab24773ed72dfd84c2))

## [0.2.1](https://github.com/dosu-ai/sessiondb/compare/v0.2.0...v0.2.1) (2026-11-02)


### Bug Fixes

* **redact:** catch bare Pulumi and Supabase access tokens ([290e992](https://github.com/dosu-ai/sessiondb/commit/290e99234135f9ed93b482afb82090c221b97533))

# [0.2.0](https://github.com/dosu-ai/sessiondb/compare/v0.1.0...v0.2.0) (2026-10-30)


### Bug Fixes

* **release:** publish with npm publish --workspaces=false instead of the npm plugin ([bbed95c](https://github.com/dosu-ai/sessiondb/commit/bbed95c34737778e8414192832167629f55854e8))
* **release:** push the release commit as the abbs-bot app, main's one bypass actor ([84df3b3](https://github.com/dosu-ai/sessiondb/commit/84df3b34d11c0b6ff05ccc08954179a2ba51314d))
* **release:** sync the workspace versions in bun.lock, which bun install leaves alone ([31c3a89](https://github.com/dosu-ai/sessiondb/commit/31c3a8968c6c9ee3523974fc0d51ab912fc39d06))
* **spec:** document the 415 for a Content-Encoding other than gzip, and exercise it ([5689bb7](https://github.com/dosu-ai/sessiondb/commit/5689bb75ba2b61b976175e402d07384f19174b07))
* **test:** resolve @dosu/sessiondb to its source under Vitest, which lacks the bun condition ([1f00781](https://github.com/dosu-ai/sessiondb/commit/1f00781e01b07d46088fb198116342ecfad66336))


### Features

* **release:** @dosu/sessiondb, released from main by semantic-release ([7aa0fb1](https://github.com/dosu-ai/sessiondb/commit/7aa0fb139a752064ef99be34b9db831d3dbaf327))
* **sdk:** publishable @dosu-ai/sessiondb: dist build, Node loading, timeoutMs and userAgent ([01b2ab3](https://github.com/dosu-ai/sessiondb/commit/01b2ab3e7e1ee663f8408828b8e4733cd266beea))
