# DSH Voicebox 预览版安装与回退

当前候选：`0.2.0-beta.2`。这是开发候选包，尚未发布到 npm 或 GitHub Release。

## 支持条件

- DSH `0.2.1-rc.1` 或 `0.2.1-rc.2`；当前只声明已验证的版本，其他版本需先通过兼容验收。
- Windows + NVIDIA CUDA 是首版真实运行验证范围。插件加载测试覆盖的系统不等于语音引擎硬件支持范围。
- 运行本仓库 `249ace2` 或后续兼容构建的 Voicebox 服务。仅看 `0.6.0` 版本号不能证明接口兼容。
- 需要 Qwen Base 的 `0.6B` 或 `1.7B` 模型、兼容的克隆声音档案；连续语音另外需要缓存的 Whisper 模型。
- 后端必须提供可取消的 `/speak`、`/generate/{generation_id}/live` 和请求身份 / 播放所有者 / 输出策略参数。

## 安装预构建插件

1. 启动配套 Voicebox，并准备模型和声音档案。
2. 使用 DSH 的插件安装入口，或其官方命令安装候选包：

   使用 CLI 时，先至少启动一次 Desktop 完成 profile 初始化，再完全退出 Desktop 后执行；应用内安装入口遵循界面提示。

   ```powershell
   dsh plugin --profile desktop add ./dsh-voicebox-0.2.0-beta.2.tgz
   ```

3. 按 DSH 提示重新加载。在插件配置中填写服务地址、选择声音档案；其他参数可以保留默认值。
4. 使用“检查安装条件”核对已保存设置。检查不会打开麦克风、合成语音或下载模型。
5. 手动朗读一条回复；再在已选工作区的空白会话中点击“语音对话”，按设备提示授权麦克风。

预构建包已包含宿主和浏览器代码，不要求用户克隆本仓库或安装构建依赖。源码构建目前仍在 Voicebox 仓库中进行，不支持把插件源码目录单独复制后编译。

## 更新和回退

- 更新前保留旧插件安装包及当前插件配置副本；在现有语音播放结束后操作。
- 安装新的 `.tgz` 使用同一命令与同一 profile，随后重新加载，并检查模型、声音档案和自动朗读偏好。
- 尚未发布的开发候选若反复重建同一版本，请优先使用 `verification.json` 中 `candidate.file` 指向的文件：构建自动生成带 SHA-256 前 12 位的副本，新内容会得到新文件名。覆盖原路径后再次安装可能命中包管理器旧缓存。正式分发的同版本包应保持内容不变。
- 如需回退，重新安装保留的旧 `.tgz` 并重新加载。插件回退不会自动回退 Voicebox 后端；需要同时核对配套服务的接口能力。
- 本候选没有修改配置 schema 中现有字段，也没有数据库迁移。跨未来版本仍应先在测试 profile 验证回退。
- 卸载可使用 `dsh plugin --profile desktop remove dsh-voicebox`。插件结束时会释放监听和播放资源，不应删除 Voicebox 声音或模型。

## 开发者候选包验收

```powershell
cd integrations/dsh-voicebox
bun install --frozen-lockfile --ignore-scripts
bun run test
bun run verify:package
```

验证脚本从固定已提交版本构建 `0.1.0` 基线，再打包当前候选。在工作区之外的临时依赖目录中安装基线、升级候选、回退基线，分别以 Node 加载打包宿主与客户端。产物、SHA-256 和结果位于仓库 `release/dsh-voicebox-candidate/`，不操作现有 Desktop profile，也不访问真实麦克风或模型。

该验证证明预构建包及依赖隔离、版本替换，不能替代原生 Desktop 安装器、实际会话生命周期或蓝牙音响验收。临时目录保留供排查，路径写入验证清单。

Windows 已安装 DSH Desktop 时，可进一步运行官方 CLI 安装验收：

```powershell
$env:VOICEBOX_DSH_DESKTOP='D:/Program/DSHDesktop'
bun run verify:dsh
```

它在仓库 `.tmp-dsh-package-*` 目录建立独立 `DSH_HOME`，通过官方 CLI / pnpm 安装、升级与回退；每一步核对配置组合与已安装宿主 / 客户端文件的 SHA-256，确认与实际安装包一致，并使用该已安装版本的真实 Cordis / Connection / SessionStore 测试打包插件。使用随附的 Web profile 模板，不启动或退出正在使用的 Desktop，不复用用户凭据与会话；因此仍不能代替原生窗口首次安装验收。结果保存在 `dsh-install-verification.json`。

同一脚本还使用当前源码的 VoiceContext，在已安装的真实 AgentLoop 中执行脚本模型续讲验收；不调用远程模型，不把“已解释”当成“已听完”。原生 Desktop 的全新 profile 仍需要用户完成它自己的首次认证引导，插件不会复制其他 profile 的凭据。

### 可选：真实本地模型循环验证

确认 Voicebox 空闲、已加载 Qwen，且已缓存 Whisper turbo 后运行：

```powershell
bun tests/local-roundtrip-smoke.mjs --run ../../release/self-check/local-roundtrip 10
```

它复用当前 Qwen 规格、已有 DSH 默认声音绑定，以一条合成短句重复验证真实识别、唯一提交、生产分句队列和静默 PCM 调度。回复 / 会话上下文为脚本，不访问真实麦克风或扬声器，不调用远程 LLM，不下载模型、不写用户配置。测试历史和合成音频均保留；结果与 WAV 写入指定目录。它不能代替真实设备、音质和自然追问验收。

另外可使用同样的空闲与模型条件，检查真实推理取消、请求去重及取消后恢复：

```powershell
bun tests/local-recovery-smoke.mjs --run ../../release/self-check/local-recovery
```

它仅操作随机测试会话及该次创建的任务，保留全部历史；不会重启服务或停止其他会话。结果包含服务端取消收尾观察时间，不能用于判断硬件静音速度。
