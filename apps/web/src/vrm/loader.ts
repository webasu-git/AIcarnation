import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'

export type { VRM }

function createLoader(): GLTFLoader {
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  return loader
}

/** VRM 0.x / 1.0 を読み込む。source は ArrayBuffer（ローカルファイル）か URL */
export async function loadVrm(source: ArrayBuffer | string): Promise<VRM> {
  const loader = createLoader()
  const gltf =
    typeof source === 'string'
      ? await loader.loadAsync(source)
      : await loader.parseAsync(source, '')

  const vrm = gltf.userData.vrm as VRM | undefined
  if (!vrm) {
    throw new Error('VRMファイルではありません')
  }

  VRMUtils.removeUnnecessaryVertices(gltf.scene)
  VRMUtils.combineSkeletons(gltf.scene)
  // VRM 0.x は -Z 向きなので 1.0 と同じ +Z 向きに揃える
  VRMUtils.rotateVRM0(vrm)
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false
  })
  return vrm
}

export function disposeVrm(vrm: VRM): void {
  VRMUtils.deepDispose(vrm.scene)
}

/** meta.metaVersion は 0.x なら '0'、1.0 なら '1' */
export function vrmSpecLabel(vrm: VRM): string {
  return vrm.meta.metaVersion === '0' ? 'VRM 0.x' : 'VRM 1.0'
}
