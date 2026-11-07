# Security Policy / セキュリティについて

## Reporting a vulnerability / 脆弱性の知らせ方

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting instead:
**Security** tab → **Report a vulnerability** on <https://github.com/webasu-git/AIcarnation>.

セキュリティの問題は、公開の Issue には書かないでください。GitHub の非公開の報告をお使いください：
<https://github.com/webasu-git/AIcarnation> の **Security** タブ →「**Report a vulnerability**」。

Please include the affected version, steps to reproduce, and the impact you expect.
対象の版、再現の手順、想定される影響を添えていただけると助かります。

## Scope / 対象

- The Claude Code plugin (`plugins/aicarnation/`), including its local server, MCP server, and engine installer.
- The web UI (`apps/web/`) and the optional relay API (`apps/api/`).

3D models, voice models, and motion files are supplied by users and are out of scope.
3D モデル・声のモデル・動きのファイルは利用者が用意するもので、対象外です。

## Supported versions / 対応する版

Only the latest release receives security fixes. / セキュリティの修正は最新の版にだけ行います。
