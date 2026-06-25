# Windows 语音识别模块安装指南

本项目支持微信语音消息自动转文字。在 Windows 上需要手动安装以下依赖。

## 前置要求

- Python 3.10+（推荐 3.12）
- pip（随 Python 一起安装）

## 安装步骤

### 1. 安装 SILK 解码器（pysilk）

微信语音格式为 SILK v3，需要 pysilk 解码为 PCM：

```bash
pip install pysilk silk-python
```

> 如果你的系统安装了 MSVC Build Tools，也可以用 `pip install pilk`（性能更好）。pysilk 是无需编译的替代方案。

验证安装：

```bash
python -c "import pysilk; print('pysilk OK, version:', pysilk.__version__)"
```

### 2. 安装 FFmpeg

FFmpeg 用于将 PCM 转换为 WAV 格式。

**方式 A：WinGet（推荐）**

```bash
winget install Gyan.FFmpeg
```

**方式 B：手动安装**

1. 从 https://www.gyan.dev/ffmpeg/builds/ 下载 `ffmpeg-release-full.zip`
2. 解压到 `C:\ffmpeg`
3. 将 `C:\ffmpeg\bin` 添加到系统 PATH

验证安装：

```bash
ffmpeg -version
```

> 即使 ffmpeg 不在 PATH 中，程序也会自动扫描 WinGet Packages 目录和常见安装路径。

### 3. 安装 faster-whisper

faster-whisper 是本地语音转文字引擎：

```bash
pip install faster-whisper
```

验证安装：

```bash
python -c "from faster_whisper import WhisperModel; print('faster-whisper OK')"
```

### 4. 预下载模型（推荐）

首次运行时 faster-whisper 会自动下载模型，但可能因超时失败。建议提前下载：

```bash
python -c "
from faster_whisper import WhisperModel
print('Downloading model...')
model = WhisperModel('small', device='cpu', compute_type='int8')
print('Done!')
"
```

默认使用 `small` 模型（约 500MB），平衡速度和准确率。

如需更高准确率，可下载 `large-v3` 模型（约 3GB）并设置环境变量：

```bash
# 预下载
python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3', device='cpu', compute_type='int8')"

# 设置环境变量（在 daemon 启动前）
set WCC_FASTER_WHISPER_MODEL=large-v3
```

## 验证完整流水线

运行以下命令确认所有组件就绪：

```bash
python -c "
import pysilk
from faster_whisper import WhisperModel
print('[OK] pysilk:', pysilk.__version__)
print('[OK] faster-whisper: loaded')
print('All voice dependencies ready!')
"
```

然后重启 daemon：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 restart
```

发一条微信语音，应该会收到 `🎤 识别为：xxx` 的回复。

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| "语音没识别出文字" | 依赖未安装或 daemon PATH 不包含 Python | 按上述步骤安装，确认 Python 路径在系统 PATH 中 |
| 一直显示"正在输入" | faster-whisper 首次下载模型超时（180s） | 手动预下载模型（步骤 4） |
| SILK 解码失败 | pysilk 未正确安装 | 确认 `python -c "import pysilk"` 无报错 |
| ffmpeg not found | ffmpeg 未安装或不在探测路径 | 用 WinGet 安装或放到 `C:\ffmpeg\bin\` |

## 支持的模型

| 模型 | 大小 | 速度 | 准确率 | 适用场景 |
|------|------|------|--------|----------|
| `tiny` | ~75MB | 最快 | 低 | 测试用 |
| `base` | ~150MB | 快 | 中 | 短消息 |
| `small` | ~500MB | 中（默认） | 较高 | 日常使用 |
| `medium` | ~1.5GB | 慢 | 高 | 长语音 |
| `large-v3` | ~3GB | 最慢 | 最高 | 专业场景 |

通过环境变量 `WCC_FASTER_WHISPER_MODEL` 切换，例如：

```powershell
$env:WCC_FASTER_WHISPER_MODEL = "medium"
```
