# AIcarnation

> **Japanese-only for now:** the UI, the voice (AivisSpeech), and the spoken summaries are all in Japanese. English support may come in the future.

AI に顔と声を。Claude Code と Claude Desktop での会話に、3D アバター（VRM）が表情・動き・声で反応します。

- 3D モデル・人格・声（AivisSpeech の `.aivmx`）・動きは、すべてご自分で用意して入れていただく作りです。アプリには素材を同梱していません。それぞれの素材のライセンスに沿ってお使いください。
- 日本語のアプリです。画面の表示と案内は日本語で、声（AivisSpeech）も日本語で話します。返答の要約は、何語で会話していても日本語で話します。音声入力は、ブラウザの言語に合わせて聞き取ります。
- 詳しい使い方は [プラグインの説明](plugins/aicarnation/README.md) をご覧ください。

## 入れ方

必要なもの：Claude Code（入れるときはターミナルの `claude` コマンドを使います）、[Node.js](https://nodejs.org/) 18 以上、パソコンの Chrome か Edge

入れ方は、次の3つの手順です。**手順 3 の再読み込みは必ず行ってください**（行わないと、入れたプラグインが Claude Code に反映されません）。

**1. ターミナルで、次の2つを順に実行する**（Mac はターミナル.app、Windows は PowerShell）

```
claude plugin marketplace add webasu-git/AIcarnation
```

```
claude plugin install aicarnation@aicarnation
```

**2. Claude Code を開く**（デスクトップアプリの「Code」か、ターミナル版）

**3. Claude Code で、プラグインを再読み込みする**

```
/reload-plugins
```

- 手順 1 は、必ずターミナルで実行してください。Claude のデスクトップアプリの中で `/plugin` と打つと、プラグインを選ぶ画面に切り替わり、コマンドとしては動きません。ターミナルで入れたプラグインは、デスクトップアプリでもそのまま使えます（設定を共有しています）。
- `claude: command not found` と出る場合は、ターミナル版の Claude Code を入れてください（[Claude Code の入れ方](https://code.claude.com/docs/en/setup)）。

再読み込みしたら `/aicarnation` で、ブラウザにアバターが開きます。

Claude Desktop のチャットでもアバターを反応させるには、最初に一度だけ、Claude Code で `/aicarnation-desktop` を実行し、表示された内容を確かめてから `/aicarnation-desktop yes` で登録してください。Claude Desktop を開き直すと、チャットでも反応します（[詳しくはプラグインの説明](plugins/aicarnation/README.md#claude-desktop-のチャットで使う試作)）。

## このプラグインがすること

- Claude Code のセッションの間、アバターの画面を出す小さなサーバーを `127.0.0.1:48280` で動かします（このパソコンの中からしか届かず、自動で作られる合言葉で守られています）。
- AivisSpeech を入れていれば、そのエンジンを起動します。自動では何もダウンロードしません。`/aicarnation-voice install aivis yes` と打ったときだけ、公式のリリース（GitHub）からエンジンを取得し、SHA-256 を照らし合わせます。
- 返答の要約やキャラクター設定の作成には、Claude Code 自身のモデルを使います。それ以外に、会話やファイルをどこかへ送ることはなく、利用状況の送信もありません。キャラクター・設定・素材は `~/.claude/plugins/data/aicarnation/` にだけ保存します。

## セキュリティ

脆弱性の知らせ方は [SECURITY.md](SECURITY.md) をご覧ください。

## License

The code is released under the [MIT License](LICENSE).

The name "AIcarnation" and its logo are not covered by the MIT License. Please do not use them for your own products or forks in a way that suggests they are official.

3D models, voices, and motions are not part of this repository; each follows its own license.

> 状態：試作版（early preview）です。
