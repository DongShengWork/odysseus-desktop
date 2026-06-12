import os
import platform
import re
import shutil
import subprocess
import time
import shlex

from core.platform_compat import (
    NVIDIA_PATH_CANDIDATES,
    SSH_PATH_OVERRIDE,
    run_ssh_command,
)

CACHE_TTL = 24 * 3600  # 24 小时 — 硬件探测由用户通过重新扫描按钮手动触发；从 30 分钟
                       # 提升以避免在长时间会话中每次切换筛选条件都重复探测硬件。


_remote_host = None  # 由 detect_system(host=...) 设置
_remote_port = None  # 由 detect_system(ssh_port=...) 设置
_remote_platform = None  # 由 detect_system(platform=...) 设置："windows", "linux", "termux"
_last_gpu_error = None  # 由 _detect_nvidia() 在 nvidia-smi 报错时设置（驱动不匹配等）


def _run(cmd):
    try:
        if _remote_host:
            # 通过 SSH 在远程主机上运行命令
            if isinstance(cmd, list):
                cmd_str = shlex.join(str(c) for c in cmd)
            else:
                cmd_str = cmd
            r = run_ssh_command(
                _remote_host,
                _remote_port,
                cmd_str,
                timeout=15,
                connect_timeout=5,
                strict_host_key_checking=False,
                text=True,
            )
        else:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return None


def _group_gpus(gpus):
    """将相同 GPU 按 (名称, 四舍五入后的 VRAM) 分组。

    vLLM 的 tensor-parallel 仅在同款 GPU 之间工作，因此混合配置必须
    拆分为同构池。每个分组携带设备索引，以便服务命令可以通过
    CUDA_VISIBLE_DEVICES 精确绑定到某个池。按总 VRAM 最大的池优先 — 
    这是合理的自动默认推理目标。
    """
    groups = {}
    order = []
    for g in gpus:
        key = (g["name"], round(g["vram_gb"]))
        if key not in groups:
            groups[key] = {
                "name": g["name"],
                "vram_each": round(g["vram_gb"], 1),
                "count": 0,
                "indices": [],
            }
            order.append(key)
        groups[key]["count"] += 1
        groups[key]["indices"].append(g.get("index"))
    out = []
    for key in order:
        grp = groups[key]
        grp["vram_total"] = round(grp["vram_each"] * grp["count"], 1)
        out.append(grp)
    out.sort(key=lambda x: x["vram_total"], reverse=True)
    return out


def _detect_nvidia():
    global _last_gpu_error
    _last_gpu_error = None
    out = _run(["nvidia-smi", "--query-gpu=memory.total,name", "--format=csv,noheader,nounits"])
    # 兜底：非交互式 shell（或 WSL）通常只有最小化 PATH，
    # 缺少 nvidia-smi 所在路径（/usr/bin、/usr/local/cuda/bin、
    # /usr/lib/wsl/lib），所以首次调用静默返回空 → 本有
    # GPU 的机器却显示 "No GPU"。
    # 通过登录 shell 重试，并预置常见 CUDA bin 目录到 PATH。
    if not out and _remote_host:
        out = _run(
            f"bash -lc '{SSH_PATH_OVERRIDE}"
            "nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits'"
        )
    # 最后尝试：通过绝对路径调用 nvidia-smi。某些主机的登录 shell
    # 不是 bash（或 profile 报错），因此上面 bash -lc 的重试
    # 仍然返回空，但二进制文件确实存在。
    # 也处理 WSL 的情况，其中 nvidia-smi 位于 /usr/lib/wsl/lib/ —
    # 该路径可能不在服务进程的 PATH 中。
    if not out:
        for _p in NVIDIA_PATH_CANDIDATES:
            # 使用列表形式，让 subprocess.run（本地）正确解析绝对路径，
            # 而不是将整段字符串当作可执行文件名称。
            if _remote_host:
                out = _run(f"{_p} --query-gpu=memory.total,name --format=csv,noheader,nounits")
            else:
                out = _run([_p, "--query-gpu=memory.total,name", "--format=csv,noheader,nounits"])
            if out:
                break
    if not out:
        return None

    # nvidia-smi 存在但无法与驱动通信（例如更新了驱动但未重启）。
    # 它会打印错误且不输出 GPU 列 — 将此作为驱动错误上报，
    # 而不是误导性地显示 "No GPU"。
    _low = out.lower()
    if ("nvml" in _low or "driver/library version mismatch" in _low
            or "couldn't communicate" in _low or "no devices were found" in _low
            or "failed to initialize" in _low):
        _last_gpu_error = out.strip().split("\n")[0][:140] or "NVIDIA driver error"
        return None

    gpus = []
    # nvidia-smi 列出的设备，名称正常但 memory.total 非数字。
    unified = []
    # nvidia-smi 按索引顺序列出 GPU（0,1,2,...），因此行位置
    # 就是传递给 CUDA_VISIBLE_DEVICES 的 CUDA 设备索引。
    for idx, line in enumerate(out.strip().split("\n")):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2:
            try:
                vram_mb = float(parts[0])
                gpus.append({"index": idx, "name": parts[1], "vram_gb": vram_mb / 1024.0})
            except ValueError:
                # Grace Blackwell GB10 / DGX Spark 以及其他统一内存架构的
                # NVIDIA 设备上报 memory.total 为 "[N/A]"/"Not Supported"，
                # 因为 GPU 共享系统 LPDDR 内存池，而非
                # 搭载独立的显存。不要丢弃该设备 — 记下它以便
                # 后续报告统一内存 GPU，而不是显示 "No GPU"（#1340）。
                if parts[1]:
                    unified.append({"index": idx, "name": parts[1]})
                continue

    if not gpus:
        if unified:
            # 统一内存 CUDA 机器：上报由系统 RAM 支持的 GPU，以便
            # Cookbook 推荐模型并且推理可以工作。内存池是共享的
            # （不是每 GPU 独立的显存），因此一次性上报总 RAM。
            ram_gb = round(_get_ram_gb(), 1)
            gpus = [{"index": g["index"], "name": g["name"], "vram_gb": ram_gb} for g in unified]
            return {
                "gpu_name": gpus[0]["name"],
                "gpu_vram_gb": ram_gb,
                "gpu_count": len(gpus),
                "gpus": gpus,
                "gpu_groups": _group_gpus(gpus),
                "homogeneous": True,
                "backend": "cuda",
                "unified_memory": True,
            }
        return None
    total_vram = sum(g["vram_gb"] for g in gpus)
    groups = _group_gpus(gpus)
    return {
        "gpu_name": gpus[0]["name"],
        "gpu_vram_gb": round(total_vram, 1),
        "gpu_count": len(gpus),
        "gpus": gpus,
        "gpu_groups": groups,
        "homogeneous": len(groups) <= 1,
        "backend": "cuda",
    }


def classify_amd_gfx(gfx):
    """将 AMD ISA 目标（例如 "gfx1200"）映射为 (gfx, family)。

    family 取值：
      "rdna"    — 消费级 Radeon RX（gfx10xx RDNA1/2, gfx11xx RDNA3, gfx12xx RDNA4）
      "cdna"    — 数据中心 Instinct（gfx908 MI100, gfx90a MI200, gfx94x/95x MI300+）
      "gcn"     — 旧版 GCN/Vega（gfx900/906）
      "unknown" — 空值/无法识别；调用方必须保守处理

    这决定了服务策略：ROCm 上的 vLLM/SGLang 在 CDNA 上经过验证，
    但在消费级 RDNA 上不稳定（AWQ kernel 大多不支持，FP8 需要补丁），
    因此 RDNA 被引导至 GGUF/llama.cpp。
    """
    gfx = (gfx or "").lower().strip()
    m = re.fullmatch(r"gfx(\d+[a-f]?)", gfx)
    if not m:
        return "", "unknown"
    digits = m.group(1)
    if digits[:2] in ("10", "11", "12"):
        return gfx, "rdna"
    if digits in ("908", "90a") or digits[:2] in ("94", "95"):
        return gfx, "cdna"
    if digits[:1] == "9":
        return gfx, "gcn"
    return gfx, "unknown"


def _detect_amd():
    """检测 AMD GPU。同时支持独立显卡（有 mem_info_vram_total）
    和 APU / 统一内存 SoC（如 Strix Halo，后者暴露
    mem_info_vis_vram_total，或仅有 mem_info_gtt_total）。"""
    def _read(path):
        if _remote_host:
            val = _run(["cat", path])
            return val.strip() if val else None
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                return f.read().strip()
        except Exception:
            return None

    def _list_drm_cards():
        if _remote_host:
            out = _run(["ls", "/sys/class/drm"])
            if not out:
                return []
            return [e for e in out.split() if e.startswith("card") and "-" not in e]
        try:
            return [e for e in os.listdir("/sys/class/drm") if e.startswith("card") and "-" not in e]
        except Exception:
            return []

    def _amd_arch():
        """尽力从 rocminfo 获取 AMD GPU ISA + family。

        rocminfo 是权威来源；其 GPU agent 报告 `Name: gfxNNNN`
        行（CPU agent 报告品牌字符串而非 gfx 目标），因此第一个
        gfx 匹配就是 GPU ISA。返回 (gfx, family) — 参见 classify_amd_gfx。
        """
        info = _run(["rocminfo"]) or _run(["/opt/rocm/bin/rocminfo"]) or ""
        m = re.search(r"gfx\d+[a-f]?", info)
        return classify_amd_gfx(m.group(0) if m else "")

    try:
        cards = []
        is_apu = False
        for _cidx, entry in enumerate(_list_drm_cards()):
            base = f"/sys/class/drm/{entry}/device"
            vendor = _read(f"{base}/vendor")
            if vendor != "0x1002":
                continue
            # 独立显卡通常在 mem_info_vram_total 中报告真实 VRAM，
            # 而某些 AMD APU / Docker 视图暴露一个很小的 vram_total 和
            # vis_vram_total 中的可用池。取两者中较大的值；
            # 仅在两个 VRAM 字段都不可用时才回退到 GTT。
            vram_raw = _read(f"{base}/mem_info_vram_total")
            vis_raw = _read(f"{base}/mem_info_vis_vram_total")
            gtt_raw = _read(f"{base}/mem_info_gtt_total")
            vram_val = int(vram_raw) if vram_raw and vram_raw.isdigit() else 0
            vis_val = int(vis_raw) if vis_raw and vis_raw.isdigit() else 0
            gtt_val = int(gtt_raw) if gtt_raw and gtt_raw.isdigit() else 0
            vram_bytes = max(vram_val, vis_val)
            if vram_bytes <= 0:
                vram_bytes = gtt_val
            if vis_val and vis_val >= vram_val:
                is_apu = True
            if vram_bytes <= 0:
                continue
            name = _read(f"{base}/product_name") or f"AMD GPU ({entry})"
            cards.append({"index": _cidx, "name": name, "vram_gb": vram_bytes / (1024**3)})

        if not cards:
            return None
        total_vram = sum(c["vram_gb"] for c in cards)
        groups = _group_gpus(cards)
        gfx, family = _amd_arch()
        # 注意：对于有 BIOS UMA 分配区的 APU（例如 Strix Halo），vis_vram_total
        # 是真实可用的 GPU 内存 — 它由物理内存支持但被 BIOS
        # 预留，因此不会出现在 /proc/meminfo 中。不要将其限制在系统 RAM
        # 范围内：从操作系统视角来看这两个池是分开的。
        return {
            "gpu_name": cards[0]["name"],
            "gpu_vram_gb": round(total_vram, 1),
            "gpu_count": len(cards),
            "gpus": cards,
            "gpu_groups": groups,
            "homogeneous": len(groups) <= 1,
            "backend": "rocm",
            "unified_memory": is_apu,
            # AMD ISA/family，下游可据此区分数据中心 Instinct（CDNA，
            # 可运行 vLLM/SGLang/AWQ/GPTQ）与消费级 Radeon
            # （RDNA，实际路径为 GGUF via llama.cpp）。空值 /
            # "unknown" 表示 rocminfo 不可用 — 调用方必须
            # 保守处理，不要假设 vLLM 可用。
            "gpu_arch": gfx,
            "gpu_family": family,
        }
    except Exception:
        return None


def _detect_apple_silicon():
    """检测 Apple Silicon（M 系列）GPU。

    Mac 没有独立显存 — GPU 共享系统的统一内存。
    我们上报总 RAM 的一部分作为可用 GPU 预算（匹配 macOS 的
    默认 Metal 工作集限制），这样 Cookbook 会推荐实际
    能在 GPU 上运行的模型，而不是将该机器归类为纯 CPU。

    backend="metal" 是 services.hwfit.fit 和服务命令生成
    所依赖的标识（它们已理解 MLX / llama.cpp-Metal）。适用于本地
    （platform.system()=="Darwin"）和 SSH（uname -s == Darwin）。
    """
    # 限制到 macOS — 本地通过 platform，远程通过 uname。
    if _remote_host:
        if "darwin" not in (_run(["uname", "-s"]) or "").lower():
            return None
        arch = (_run(["uname", "-m"]) or "").lower()
    else:
        if platform.system() != "Darwin":
            return None
        arch = platform.machine().lower()

    # 仅 Apple Silicon（arm64）才有值得推理 LLM 的 Metal GPU；Intel
    # Mac 回退到 CPU 路径。
    if "arm" not in arch and "aarch64" not in arch:
        return None

    # 芯片名称，例如 "Apple M4 Max" — 携带 Pro/Max/Ultra 变体，
    # 用于 fit 带宽表的匹配。
    brand = (_run(["sysctl", "-n", "machdep.cpu.brand_string"]) or "Apple Silicon").strip()

    # 统一内存总大小（字节）。
    memsize = _run(["sysctl", "-n", "hw.memsize"])
    try:
        total_gb = int(memsize) / (1024**3) if memsize else 0.0
    except ValueError:
        total_gb = 0.0
    if total_gb <= 0:
        return None

    # 可用 GPU 预算。macOS 允许 Metal 使用大部分统一内存，但
    # 默认工作集限制随 RAM 大小调整：小内存机器需要为
    # 系统和应用保留更多空间。这些比例跟踪了 Apple 全系列
    # recommendedMaxWorkingSetSize 的默认值。如果用户通过
    # `sudo sysctl iogpu.wired_limit_mb=…` 提升了该值，则优先使用显式的覆盖值。
    if total_gb <= 16:
        frac = 0.67
    elif total_gb <= 64:
        frac = 0.75
    else:
        frac = 0.80
    vram_gb = round(total_gb * frac, 1)
    wired = _run(["sysctl", "-n", "iogpu.wired_limit_mb"])
    try:
        wired_mb = int(wired) if wired else 0
        if wired_mb > 0:
            vram_gb = round(wired_mb / 1024.0, 1)
    except ValueError:
        pass

    gpu = {"index": 0, "name": brand, "vram_gb": vram_gb}
    return {
        "gpu_name": brand,
        "gpu_vram_gb": vram_gb,
        "gpu_count": 1,
        "gpus": [gpu],
        "gpu_groups": _group_gpus([gpu]),
        "homogeneous": True,
        "backend": "metal",
        # 统一内存：上面的 "VRAM" 是从系统 RAM 中划出的，并非
        # 独立池 — 下游 fit 逻辑据此避免重复计入预算。
        "unified_memory": True,
    }


def _read_file(path):
    """本地或通过 SSH 读取文件。"""
    if _remote_host:
        return _run(["cat", path])
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return None


def _parse_meminfo():
    """将 /proc/meminfo 解析为 key -> KB 值的字典。"""
    text = _read_file("/proc/meminfo")
    if not text:
        return {}
    result = {}
    for line in text.split("\n"):
        if ":" in line:
            key, val = line.split(":", 1)
            parts = val.strip().split()
            if parts:
                try:
                    result[key.strip()] = int(parts[0])
                except ValueError:
                    pass
    return result


def _get_ram_gb():
    meminfo = _parse_meminfo()
    if "MemTotal" in meminfo:
        return meminfo["MemTotal"] / (1024**2)

    # os.sysconf 仅在 Unix 上存在；Windows 上不存在（AttributeError），
    # 这些常量也未定义 — 添加保护确保此处永远不会抛出异常。
    if not _remote_host and hasattr(os, "sysconf") and "SC_PHYS_PAGES" in getattr(os, "sysconf_names", {}):
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            if pages and page_size:
                return (pages * page_size) / (1024**3)
        except Exception:
            pass

    # macOS 没有 /proc/meminfo — 回退到 sysctl（适用于本地和
    # SSH 连接远程 Mac，此时不会执行上面的 sysconf 路径）。
    memsize = _run(["sysctl", "-n", "hw.memsize"])
    if memsize:
        try:
            return int(memsize.strip()) / (1024**3)
        except ValueError:
            pass
    return 0.0


def _get_available_ram_gb():
    meminfo = _parse_meminfo()
    if "MemAvailable" in meminfo:
        return meminfo["MemAvailable"] / (1024**2)
    return _get_ram_gb() * 0.7


def _get_cpu_name():
    text = _read_file("/proc/cpuinfo")
    if text:
        for line in text.split("\n"):
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()

    # macOS 没有 /proc/cpuinfo — sysctl 返回芯片名称（例如 "Apple M4"）。
    # 在 Linux 上无害地返回空，因此可以无条件安全尝试。
    brand = _run(["sysctl", "-n", "machdep.cpu.brand_string"])
    if brand and brand.strip():
        return brand.strip()

    if not _remote_host:
        return platform.processor() or "unknown"
    return "unknown"


def _get_cpu_count():
    if _remote_host:
        # Linux 上使用 nproc；远程 Mac 上使用 sysctl hw.ncpu（无 nproc 命令）。
        out = _run(["nproc"]) or _run(["sysctl", "-n", "hw.ncpu"])
        if out:
            try:
                return int(out.strip())
            except ValueError:
                pass
        # 兜底：在 /proc/cpuinfo 中统计 "processor" 行数
        text = _read_file("/proc/cpuinfo")
        if text:
            return sum(1 for line in text.split("\n") if line.startswith("processor"))
    return os.cpu_count() or 1


def _powershell_exe():
    """为本地执行选择最佳 PowerShell 可执行文件：优先 pwsh
    （PowerShell 7+），回退到 Windows PowerShell 5.1。返回绝对
    路径，不依赖特定的 PATH 顺序。"""
    return shutil.which("pwsh") or shutil.which("powershell") or "powershell"


def _detect_windows():
    """通过 PowerShell/WMI 检测 Windows 硬件。

    同时适用于本地（host=""）和远程（SSH）检测：
      * 远程 -> `_run` 将命令字符串通过 SSH 发送到远程主机。
      * 本地 -> `_run` 直接执行列表形式的 argv（无 shell 引号转义问题）。
    """
    # 用单个 PowerShell 命令一次性收集所有硬件信息
    ps_cmd = (
        """
        $r = @{}
        $os = Get-CimInstance Win32_OperatingSystem
        $r.ram_gb = [math]::Round($os.TotalVisibleMemorySize / 1048576, 1)
        $r.avail_gb = [math]::Round($os.FreePhysicalMemory / 1048576, 1)
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        $r.cpu_name = $cpu.Name
        $r.cpu_cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
        $r.arch = $cpu.AddressWidth
        # GPU 检测通过 nvidia-smi（最快）或 WMI 兜底
        try { 
            $nv = nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits 2>$null
            if ($LASTEXITCODE -eq 0 -and $nv) { 
                $gpus = @()
                foreach ($line in $nv -split "`n") { 
                    $p = $line -split ','
                    if ($p.Count -ge 2) { $gpus += [pscustomobject]@{name = $p[1].Trim(); vram_mb = [double]$p[0].Trim() } } 
                }
                $r.gpu_name = $gpus[0].name
                $r.gpu_vram_gb = [math]::Round(($gpus | Measure-Object -Property vram_mb -Sum).Sum / 1024, 1)
                $r.gpu_count = $gpus.Count
                $r.gpu_backend = 'cuda'
            } 
        }
        catch {}
        if (-not $r.gpu_name) { 
            $wmiGpu = Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -gt 0 } | Select-Object -First 1
            $GPUDriverKey = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*"
            $GPUDeviceID = $wmiGpu.PNPDeviceID.Split('&')[0..1] -join '&'
            $VRAMfromRegistry = Get-ItemProperty -Path $GPUDriverKey |
            Where-Object { $_.MatchingDeviceId -like "${GPUDeviceID}*" } |
            # 同一 GPU 有时会匹配到多个驱动类。
            Select-Object -ExpandProperty HardwareInformation.qwMemorySize -ErrorAction SilentlyContinue -First 1
            if ($wmiGpu) { 
                $r.gpu_name = $wmiGpu.Name
                # 边缘情况：驱动损坏，否则 $wmiGpu.AdapterRAM 是冗余的
                if ($VRAMfromRegistry -ge $wmiGpu.AdapterRAM) {
                    $r.gpu_vram_gb = [math]::Round($VRAMfromRegistry / 1073741824, 1)
                }
                else {
                    $r.gpu_vram_gb = [math]::Round($wmiGpu.AdapterRAM / 1073741824, 1)
                }
                $r.gpu_count = 1
                # WMI 无法告诉我们是 CUDA 还是 ROCm
                $r.gpu_backend = 'cpu_x86';
            } 
        }
        $r | ConvertTo-Json -Compress
    """
    )
    if _remote_host:
        # 远程：通过 SSH 发送单个命令字符串。远程 shell 解析
        # 引号；远端的 PowerShell 执行 -Command 载荷。
        out = _run(f'powershell -Command "{ps_cmd}"')
    else:
        # 本地：将列表型 argv 直接传给 subprocess，让操作系统将 ps_cmd
        # 原样递给 PowerShell — 无需脆弱的字符串级引号转义。优先
        # pwsh（PS7），否则回退到 Windows PowerShell 5.1。
        out = _run([_powershell_exe(), "-NoProfile", "-NonInteractive", "-Command", ps_cmd])
    if not out:
        return None
    import json as _json
    try:
        d = _json.loads(out)
        # PowerShell 的 Measure-Object .Sum / .Count 返回 JSON 数字时
        # 解码为 float；Linux 路径对这些值返回普通 int — 强制转换
        # 以确保字典结构（及下游整数运算）跨平台一致。
        def _as_int(v, default):
            try:
                return int(v)
            except (TypeError, ValueError):
                return default
        _cpu_name = (d.get("cpu_name") or "unknown")
        if isinstance(_cpu_name, str):
            _cpu_name = _cpu_name.strip() or "unknown"
        result = {
            "total_ram_gb": d.get("ram_gb", 0),
            "available_ram_gb": d.get("avail_gb", 0),
            "cpu_cores": _as_int(d.get("cpu_cores"), 1),
            "cpu_name": _cpu_name,
            "has_gpu": bool(d.get("gpu_name")),
            "gpu_name": d.get("gpu_name"),
            "gpu_vram_gb": d.get("gpu_vram_gb"),
            "gpu_count": _as_int(d.get("gpu_count"), 0),
            "backend": d.get("gpu_backend", "cpu_x86"),
            "homogeneous": True,
            "gpu_error": None,
            "platform": "windows",
        }
        # PowerShell 仅上报聚合 GPU 信息，没有每卡详情，因此我们
        # 无法在此区分混合框和统一框 — 假设一个同构
        # 池涵盖所有上报的 GPU（Windows 的常见情况）。
        _n = result["gpu_count"] or 0
        if result["has_gpu"] and _n > 0:
            _each = round((result["gpu_vram_gb"] or 0) / _n, 1)
            result["gpus"] = [
                {"index": i, "name": result["gpu_name"], "vram_gb": _each} for i in range(_n)
            ]
            result["gpu_groups"] = [{
                "name": result["gpu_name"],
                "vram_each": _each,
                "count": _n,
                "indices": list(range(_n)),
                "vram_total": result["gpu_vram_gb"],
            }]
            result["homogeneous"] = True
        return result
    except Exception:
        return None


_cache_by_host = {}  # host -> (时间戳, 结果)


def _cache_key(host: str, ssh_port: str, platform_name: str):
    """构建稳定的缓存键以隔离远程 SSH 上下文。

    同一 host 别名可能因可见性和转发等原因具有不同硬件。
    为避免使用错误的缓存硬件信息，在缓存键中包含 SSH 端口和平台。
    """
    return (
        host or "_local",
        str(ssh_port or ""),
        str(platform_name or "").lower(),
    )


def detect_system(host="", ssh_port="", platform="", fresh=False):
    """检测系统硬件：RAM、CPU、GPU。按 host 缓存（硬件极少
    变化，且通过 SSH 探测远程主机很慢）。传入 fresh=True 可
    绕过缓存并重新探测（"重新扫描"按钮）。
    如果设置了 host（例如 'user@server'），通过 SSH 运行检测命令。
    platform: "windows"、"linux"、"termux"，或 ""（自动检测）。
    """
    global _remote_host, _remote_port, _remote_platform

    cache_key = _cache_key(host, ssh_port, platform)
    now = time.time()
    if not fresh and cache_key in _cache_by_host:
        ts, cached = _cache_by_host[cache_key]
        if (now - ts) < CACHE_TTL:
            return cached

    _remote_host = host or None
    _remote_port = ssh_port or None
    _remote_platform = platform or None

    # Windows：使用单个 PowerShell 命令获取所有硬件信息
    if _remote_platform == "windows" and _remote_host:
        result = _detect_windows()
        if result:
            _remote_host = None
            _remote_platform = None
            _cache_by_host[cache_key] = (now, result)
            return result
        # 如果 Windows 检测失败，返回错误
        result = {"error": f"Cannot connect to {host}", "host": host}
        _remote_host = None
        _remote_platform = None
        _cache_by_host[cache_key] = (now, result)
        return result

    # 本地 Windows：Linux 的 /proc + /sys + os.sysconf 路径在 Windows 上
    # 返回 0 GB RAM、"unknown" CPU 且无 GPU（os.sysconf 甚至不存在），
    # 因此改为本地通过 PowerShell/WMI 检测。_detect_windows() 运行
    # 与远程 Windows 相同的探测，但 _run() 在本地执行。
    if not _remote_host and os.name == "nt":
        result = _detect_windows()
        if result:
            _cache_by_host[cache_key] = (now, result)
            return result
        # PowerShell 探测完全失败 — 回退到下面的通用路径，
        # 至少返回一个结构良好的 dict 而不是崩溃。

    # Linux/Termux：现有的多命令检测
    total_ram = round(_get_ram_gb(), 1)
    # 如果远程主机返回 0 RAM，连接可能已失败
    if _remote_host and total_ram <= 0:
        result = {"error": f"Cannot connect to {host}", "host": host}
        _cache_by_host[cache_key] = (now, result)
        _remote_host = None
        _remote_platform = None
        return result
    available_ram = round(_get_available_ram_gb(), 1)
    cpu_cores = _get_cpu_count()
    cpu_name = _get_cpu_name()

    gpu_info = _detect_apple_silicon() or _detect_nvidia() or _detect_amd()

    if gpu_info:
        result = {
            "total_ram_gb": total_ram,
            "available_ram_gb": available_ram,
            "cpu_cores": cpu_cores,
            "cpu_name": cpu_name,
            "has_gpu": True,
            "gpu_name": gpu_info["gpu_name"],
            "gpu_vram_gb": gpu_info["gpu_vram_gb"],
            "gpu_count": gpu_info["gpu_count"],
            "gpus": gpu_info.get("gpus", []),
            "gpu_groups": gpu_info.get("gpu_groups", []),
            "homogeneous": gpu_info.get("homogeneous", True),
            "backend": gpu_info["backend"],
            # Apple Silicon / AMD APU 与 GPU 共享系统 RAM — 传递该
            # 标志以便调用方区分统一内存和独立显存。
            "unified_memory": gpu_info.get("unified_memory", False),
        }
    else:
        if _remote_host:
            arch_out = _run(["uname", "-m"]) or ""
        else:
            import platform as _platform
            arch_out = _platform.machine().lower()
        backend = "cpu_arm" if "aarch64" in arch_out or "arm" in arch_out else "cpu_x86"
        result = {
            "total_ram_gb": total_ram,
            "available_ram_gb": available_ram,
            "cpu_cores": cpu_cores,
            "cpu_name": cpu_name,
            "has_gpu": False,
            "gpu_name": None,
            "gpu_vram_gb": None,
            "gpu_count": 0,
            "backend": backend,
            # 当 nvidia-smi 存在但失败时设置（例如驱动/库版本不匹配）
            # — 让 UI 可以显示 "GPU 驱动错误" 而非误导性的 "No GPU"。
            "gpu_error": _last_gpu_error,
        }

    _remote_host = None
    _remote_platform = None
    _cache_by_host[cache_key] = (now, result)
    return result
