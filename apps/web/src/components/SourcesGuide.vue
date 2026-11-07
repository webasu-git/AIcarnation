<script setup lang="ts">
/**
 * 素材の入手先の案内。アプリは素材（3D モデル・声・動き）を含まず、受け渡しもしない。
 * 素材は利用者が自分で用意し、それぞれのライセンス・規約を守って使う
 */
const SOURCES = [
  {
    kind: '3D モデル（.vrm）',
    items: [
      { name: 'VRoid Studio', url: 'https://vroid.com/studio', note: 'ご自分でキャラクターを作れます（無料）' },
      { name: 'VRoid Hub・BOOTH など', url: 'https://hub.vroid.com/', note: '配布されているモデルは、モデルごとの利用条件に従ってお使いください' },
    ],
  },
  {
    kind: '声（.aivmx）',
    items: [
      { name: 'AivisHub', url: 'https://hub.aivis-project.com/', note: 'AivisSpeech の声のモデルを入手できます。ライセンスはモデルごとに異なります' },
    ],
  },
  {
    kind: '動き（.vrma・.fbx）',
    items: [
      { name: 'Mixamo', url: 'https://www.mixamo.com/', note: 'ご自分でダウンロードした FBX をそのまま追加できます（Adobe ID が必要です。元ファイルの再配布はできません）' },
    ],
  },
] as const
</script>

<template>
  <div class="sources">
    <p class="hint">
      このアプリに素材は含まれていません。3D モデル・声・動きはご自分でご用意いただき、それぞれのライセンスや規約（再配布の可否・クレジット・商用利用など）をお確かめのうえ、お使いください。
    </p>
    <dl>
      <template v-for="s in SOURCES" :key="s.kind">
        <dt>{{ s.kind }}</dt>
        <dd v-for="i in s.items" :key="i.name">
          <a :href="i.url" target="_blank" rel="noopener noreferrer">{{ i.name }}</a>
          <span>{{ i.note }}</span>
        </dd>
      </template>
    </dl>
  </div>
</template>

<style scoped>
dl {
  margin: 8px 0 0;
}
dt {
  margin-top: 10px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text);
}
dd {
  display: flex;
  flex-direction: column;
  margin: 4px 0 0;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: var(--surface);
}
dd a {
  font-size: 0.82rem;
  color: var(--accent-strong);
}
dd span {
  font-size: 0.72rem;
  color: var(--muted);
}
</style>
