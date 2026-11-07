# AIcarnation

> **Japanese-only for now:** the UI, the voice (AivisSpeech), and the spoken summaries are all in Japanese. English support may come in the future.

AI に顔と声を。Claude Code と Claude Desktop での会話に、3D アバター（VRM）が表情・動き・声で反応します。

- 3D モデル・人格・声（AivisSpeech の `.aivmx`）・動きは、すべてご自分で用意して入れていただく作りです。アプリには素材を同梱していません。それぞれの素材のライセンスに沿ってお使いください。
- 日本語のアプリです。画面の表示と案内は日本語で、声（AivisSpeech）も日本語で話します。返答の要約は、何語で会話していても日本語で話します。音声入力は、ブラウザの言語に合わせて聞き取ります。
- 詳しい使い方は [プラグインの説明](plugins/aicarnation/README.md) をご覧ください。

## 入れ方

必要なもの：Claude Code、[Node.js](https://nodejs.org/) 18 以上、パソコンの Chrome か Edge

Claude Code で次の2つを実行し、Claude Code を開き直してください。

```
/plugin marketplace add webasu-git/AIcarnation
/plugin install aicarnation@aicarnation
```

開き直したら `/aicarnation` で、ブラウザにアバターが開きます。

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
