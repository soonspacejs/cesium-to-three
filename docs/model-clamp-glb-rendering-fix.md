# Model Clamp GLB 渲染问题修复记录

> 记录时间：2026-07-09  
> 问题范围：`src/demo/model-clamp-demo.ts` 中把 `public/Untitle.glb` 加载到标绘矩形中心后，模型与地形/影像/标绘一起渲染时出现遮挡、黑屏、底部变色等异常。

## 现象

1. GLB 模型接触或靠近地形时，局部会被地形遮挡，看起来像模型底部或侧面被切掉。
2. 在错误的二次渲染时机下，影像和标绘会被黑色背景覆盖。
3. 对 GLB 半透明材质做额外 backfill 后，模型红色/橙色半透明面会发暗、发橙，并出现类似条纹的二次叠色。

## 根因

`um-3d-tiles-renderer` 的 tiles 本质是 Three `Object3D`，本项目把地形、倾斜摄影、标绘、GLB 都挂到了同一个 Three `Scene`。如果一次性调用：

```ts
renderer.render( scene, camera );
```

地形和倾斜摄影先写入的 depth buffer 会参与 GLB 的深度测试。GLB 与地形接触时，模型片元可能被前面写入的 terrain depth 挡掉。

Cesium 的默认行为不是这样。Cesium 中 `Globe.depthTestAgainstTerrain` 默认是 `false`，对应渲染流程会在画 3D Tiles / opaque entities 前执行 `clearDepth`，避免普通模型被 globe terrain depth 直接裁掉。

## 错误尝试

不要为了解决底部串色去改 GLB 的透明材质，例如把 `alphaMode=BLEND` 材质临时改成不透明再画一遍。

`Untitle.glb` 内部包含半透明材质，Three 官方 `GLTFLoader` 正常渲染时只按 glTF 材质画一次。如果额外先把透明面当不透明 backfill，再恢复透明渲染，就会造成二次叠色，表现为大面积发暗、发橙或条纹。

## 最终方案

GLB 加载方式保持 Three 官方方式：

```ts
gltfLoader.load( RECTANGLE_GLB_MODEL_URL, gltf => {
	const modelScene = gltf.scene;
	rectangleGlbAnchor.add( modelScene );
} );
```

渲染流程改为两段：

1. GLB 放到独立 Three layer：`RECTANGLE_GLB_RENDER_LAYER = 2`。
2. 主 pass 临时禁用 GLB layer，渲染地形、倾斜摄影、影像、标绘。
3. 如果 GLB 可见，临时设置 `scene.background = null`，避免第二次 `renderer.render` 把已画好的颜色背景盖掉。
4. 执行 `renderer.clearDepth()`，只清深度，不清颜色。
5. 相机切到 GLB layer，只渲染 GLB 一次。
6. 恢复 `scene.background`、`renderer.autoClear` 和相机 layer mask。

核心代码形态：

```ts
const previousCameraLayerMask = camera.layers.mask;
camera.layers.disable( RECTANGLE_GLB_RENDER_LAYER );
renderer.render( scene, camera );

if ( rectangleGlbAnchor.visible && rectangleGlbAnchor.children.length > 0 ) {
	const previousAutoClear = renderer.autoClear;
	const previousBackground = scene.background;
	renderer.autoClear = false;
	scene.background = null;
	try {
		renderer.clearDepth();
		camera.layers.set( RECTANGLE_GLB_RENDER_LAYER );
		renderer.render( scene, camera );
	} finally {
		scene.background = previousBackground;
		renderer.autoClear = previousAutoClear;
	}
}

camera.layers.mask = previousCameraLayerMask;
```

这个方案的关键点是：不修改 GLB 材质，不关闭 GLB 自身 `depthTest`，不二次绘制透明材质，只隔离 terrain depth 对 GLB 的影响。

## 相关改动

- `src/demo/model-clamp-demo.ts`
  - 使用 `GLTFLoader` + `DRACOLoader` 加载 `public/Untitle.glb`。
  - 将 GLB anchor 放到标绘矩形中心。
  - GLB 使用独立 layer，并在主场景颜色绘制完成后清 depth 再渲染一次。
  - GUI 增加 GLB 显示和定位控制。
  - GUI 增加标绘显示控制。
- `src/lib/plot/PlotPrimitiveBridge.ts`
  - 增加 `setSceneAttached`，隐藏标绘时直接从 Three scene 移除，而不是只设 `visible=false`。
- `src/lib/plot/GroundDecalManager.ts`
  - 暴露 `setSceneAttached` 给 demo 使用。

## 注意事项

1. `scene.background = null` 只在 GLB pass 内临时设置，必须在 `finally` 中恢复。
2. GLB pass 不能改材质透明状态，否则会偏离 Three 官方 `GLTFLoader` 的渲染结果。
3. 只应提交当前使用的 `public/Untitle.glb`，不要把临时测试模型一并提交。
