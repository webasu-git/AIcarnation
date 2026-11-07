# AIcarnation

> **Japanese-only for now:** the UI, the voice (AivisSpeech), and the spoken summaries are all in Japanese. English support may come in the future.

AI に顔と声を。Claude Code と Claude Desktop での会話に、3D アバター（VRM）が表情・動き・声で反応します。

- 3D モデル・人格・声（AivisSpeech の `.aivmx`）・動きは、すべてご自分で用意して入れていただく作りです。アプリには素材を同梱していません。それぞれの素材のライセンスに沿ってお使いください。
- 日本語のアプリです。画面の表示と案内は日本語で、声（AivisSpeech）も日本語で話します。返答の要約は、何語で会話していても日本語で話します。音声入力は、ブラウザの言語に合わせて聞き取ります。
- 詳しい使い方は [プラグインの説明](plugins/aicarnation/README.md) をご覧ください。

## 入れ方

必要なもの：Claude Code（入れるときはターミナルの `claude` コマンドを使います）、[Node.js](https://nodejs.org/) 18 以上、パソコンの Chrome か Edge

入れ方は、次の3つの手順です。Claude Code と Claude Desktop のチャットの両方で、アバターが反応するようになります。

**1. Claude のアプリを終了する**（Windows はタスクトレイのアイコンから「終了」、Mac は ⌘Q）

**2. ターミナルで、次の3つを順に実行する**（Windows は PowerShell、Mac はターミナル。どちらも同じ文をそのまま貼れます）

```
claude plugin marketplace add webasu-git/AIcarnation
```

```
claude plugin install aicarnation@aicarnation
```

```
node "$HOME/.claude/plugins/marketplaces/aicarnation/plugins/aicarnation/server/setup-desktop.mjs"
```

**3. Claude のアプリ（または Claude Code）を開いて、プラグインを再読み込みする**

```
/reload-plugins
```

- 手順 3 の再読み込みは必ず行ってください。行わないと、入れたプラグインが反映されません。
- 手順 2 の3つ目のコマンドは、Claude Desktop のチャットへの登録です。Claude のアプリを起動したまま実行すると、アプリを終了するときに登録が消えてしまうので、必ずアプリを終了してから実行してください（起動中は、登録せずに知らせます）。
- Windows では、コマンドプロンプト（cmd）ではなく PowerShell で実行してください（`$HOME` が自分のフォルダに置き換わるのは PowerShell です）。
- Claude のデスクトップアプリの中で `/plugin` と打つと、プラグインを選ぶ画面に切り替わり、コマンドとしては動きません。入れるときは、必ずターミナルで実行してください。
- `claude: command not found` と出る場合は、ターミナル版の Claude Code を入れてください（[Claude Code の入れ方](https://code.claude.com/docs/en/setup)）。

再読み込みしたら、Claude Code では `/aicarnation`、チャットでは「アバターを開いて」と頼むと、ブラウザにアバターが開きます。

## このプラグインがすること

- Claude Code のセッションの間、アバターの画面を出す小さなサーバーを `127.0.0.1:48280` で動かします（このパソコンの中からしか届かず、自動で作られる合言葉で守られています）。
- AivisSpeech を入れていれば、そのエンジンを起動します。自動では何もダウンロードしません。`/aicarnation-voice install aivis yes` と打ったときだけ、公式のリリース（GitHub）からエンジンを取得し、SHA-256 を照らし合わせます。
- Claude Desktop のチャットに登録するコマンド（`setup-desktop.mjs`）を実行したときだけ、Claude Desktop の設定ファイル（`claude_desktop_config.json`）に `aicarnation` の項目を足します（書き換える前の設定は控えとして残します）。
- 返答の要約やキャラクター設定の作成には、Claude Code 自身のモデルを使います。それ以外に、会話やファイルをどこかへ送ることはなく、利用状況の送信もありません。キャラクター・設定・素材は `~/.claude/plugins/data/aicarnation/` にだけ保存します。

## セキュリティ

脆弱性の知らせ方は [SECURITY.md](SECURITY.md) をご覧ください。

## License

The code is released under the [MIT License](LICENSE).

The name "AIcarnation" and its logo are not covered by the MIT License. Please do not use them for your own products or forks in a way that suggests they are official.

3D models, voices, and motions are not part of this repository; each follows its own license.

> 状態：試作版（early preview）です。
