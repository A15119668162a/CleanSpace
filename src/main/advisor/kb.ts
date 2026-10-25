/**
 * 大文件体检知识库（v3.0 / G3）
 * 200+ 规则：文件名模式 → 人话解释 + 结论档位
 * 结论档位：safe(🟢可删) / caution(🟡谨慎) / danger(🔴别动) / unknown(未知不装懂)
 * 红线 14：拿不准就 unknown——建议绝不代删
 */

export type Advice = 'safe' | 'caution' | 'danger' | 'unknown'

export interface KbRule {
  id: string
  /** 文件名匹配（小写包含，多词任一命中；或 glob 用 *） */
  match: string[]
  /** 这是什么（人话） */
  what: string
  /** 能不能删（结论） */
  advice: Advice
  /** 判断依据模板 */
  why: string
  /** 额外条件（可选）：需注册表已装对照等 */
  requiresInstalled?: boolean // true=已装该软件时才是 🟢（安装包场景）
  installedGuess?: string[]   // 从文件名猜软件名做对照
}

export interface AnalyzeResult {
  what: string
  advice: Advice
  why: string
  kbId?: string
  /** 未知时给出通用参考 */
  generic?: boolean
}

/* ---------------- 内置知识库 ---------------- */
export const KB: KbRule[] = [
  // —— 系统关键（🔴）——
  { id: 'sys-pagefile', match: ['pagefile.sys', 'swapfile.sys'], what: 'Windows 页面文件（虚拟内存）', advice: 'danger', why: '系统运行必需——删除会导致无法启动或运行异常。想缩小请用系统设置调整虚拟内存，不要直接删。' },
  { id: 'sys-hiberfil', match: ['hiberfil.sys'], what: '休眠文件', advice: 'danger', why: '休眠与快速启动依赖它。确实不用休眠可在管理员命令行 powercfg /h off 安全关闭（三期深度专清将提供引导）。' },
  { id: 'sys-dump', match: ['memory.dmp', 'dumpstack.log', 'dumpstack.log.tmp'], what: '系统崩溃转储', advice: 'caution', why: '记录蓝屏原因。近期没蓝屏可以清理；正在排查蓝屏请保留。' },
  { id: 'sys-winsxs', match: ['winsxs'], what: '系统组件仓库（WinSxS）', advice: 'danger', why: '系统更新与修复依赖，绝不能手动删除。只能用系统工具清理（Dism /StartComponentCleanup）。' },
  { id: 'sys-driver', match: ['drivers.cab', 'driverstore'], what: '驱动文件/驱动仓库', advice: 'danger', why: '硬件驱动依赖。误删会导致设备失灵。' },
  { id: 'sys-restore', match: ['system volume information'], what: '系统还原点存储', advice: 'danger', why: '系统还原数据。只能通过系统工具管理。' },
  { id: 'sys-prefetch', match: ['prefetch'], what: '预读取缓存', advice: 'caution', why: '加速程序启动，删了会短暂变慢（系统会重建）。收益很小，不推荐专门清理。' },

  // —— 安装包（🟢 需已装对照）——
  { id: 'setup-exe', match: ['setup', 'install', 'installer', '安装包'], what: '软件安装包', advice: 'safe', requiresInstalled: true, installedGuess: [], why: '注册表显示对应软件已安装——安装包完成使命，删除不影响已装软件（重装可再下载）。' },
  { id: 'setup-msi', match: ['.msi'], what: 'Windows 安装包（MSI）', advice: 'caution', why: '部分软件修复/卸载时需要原 MSI。对应软件已装且运行正常时可以删；不确定就保留。' },
  { id: 'update-pkg', match: ['update', '升级包', 'patch'], what: '软件更新包', advice: 'caution', why: '更新程序可能还需要它做回滚。更新完成且软件运行正常可清理。' },

  // —— 虚拟机/容器（🟡）——
  { id: 'vm-vmdk', match: ['.vmdk'], what: 'VMware 虚拟机磁盘', advice: 'caution', why: '虚拟机的整个硬盘。还在用虚拟机请务必保留；确定弃用先在 VMware 里删除虚拟机再清文件。' },
  { id: 'vm-vdi', match: ['.vdi'], what: 'VirtualBox 虚拟机磁盘', advice: 'caution', why: '虚拟机磁盘。同上——确认弃用再清。' },
  { id: 'vm-vhdx', match: ['.vhdx', '.vhd'], what: 'Hyper-V/WSL 虚拟磁盘', advice: 'caution', why: 'WSL2 或 Hyper-V 虚拟机数据盘。WSL 用户删除 = 丢失整个 Linux 数据！' },
  { id: 'vm-qcow', match: ['.qcow2'], what: 'QEMU/KVM 虚拟机磁盘', advice: 'caution', why: '虚拟机磁盘，确认弃用再清。' },
  { id: 'vm-vmem', match: ['.vmem', '.vmss'], what: '虚拟机内存快照', advice: 'caution', why: '挂起状态的虚拟机内存。虚拟机正常关机后可清。' },
  { id: 'docker', match: ['ext4.vhdx', 'docker'], what: 'Docker/WSL 数据', advice: 'caution', why: 'Docker 镜像与容器数据。删除丢失全部镜像，请用 docker system prune 正规清理。' },

  // —— 备份归档（🟡）——
  { id: 'bk-ghost', match: ['.gho', '.bak', 'ghost'], what: 'Ghost 系统备份', advice: 'caution', why: '系统备份镜像。确认有更新的备份源再删。' },
  { id: 'bk-wim', match: ['.wim', 'install.wim', 'install.esd'], what: 'Windows 镜像/系统备份', advice: 'caution', why: '系统安装镜像或备份。重装系统时可能用到。' },
  { id: 'bk-iso', match: ['.iso'], what: '光盘镜像（ISO）', advice: 'caution', why: '系统/软件安装镜像。可重新下载或确认不用了再删。' },
  { id: 'bk-old', match: ['备份', 'backup', '.old'], what: '备份文件', advice: 'caution', why: '某软件/某人的备份。确认主文件完好再清理。' },

  // —— 游戏资源（🟡）——
  { id: 'game-pak', match: ['.pak'], what: '游戏资源包', advice: 'caution', why: '游戏数据文件。删除 = 重下游戏。确认游戏已卸载或不玩了再清。' },
  { id: 'game-data', match: ['shader', 'shadercache', 'gpucache'], what: '游戏着色器缓存', advice: 'safe', why: '显卡编译缓存，删除后首次进游戏会重新编译（稍慢一次），游戏本体无损。' },

  // —— 媒体缓存（🟢）——
  { id: 'media-cache', match: ['cache', '缓存', 'thumb', 'thumbnail'], what: '媒体/缩略图缓存', advice: 'safe', why: '缓存文件，删除后自动重建。安全。' },
  { id: 'media-transcode', match: ['transcode', '转码', 'tmp', 'temp'], what: '转码/临时文件', advice: 'safe', why: '中间产物，删除不影响源文件。' },

  // —— 视频缓存（🟢）——
  { id: 'video-cache', match: ['bilibili', 'iqiyi', 'youku', 'tencent video', '离线缓存', 'download.flv'], what: '视频 App 离线缓存', advice: 'safe', why: '视频客户端的离线缓冲，删除后重新缓存即可。' },

  // —— 压缩包（🟡 已解压对照 → 🟢）——
  { id: 'zip-archive', match: ['.zip', '.rar', '.7z'], what: '压缩包', advice: 'caution', why: '先确认已解压或内容已不需要。删除前建议打开确认一眼。' },

  // —— 日志（🟢/🟡）——
  { id: 'log-app', match: ['.log', 'log.txt', '日志'], what: '日志文件', advice: 'safe', why: '程序运行日志，删除不影响功能（排查问题时有用）。' },
  { id: 'log-crash', match: ['crash', 'hs_err', '错误报告'], what: '崩溃日志', advice: 'safe', why: '程序崩溃记录。没在排查问题可清理。' },

  // —— 开发（🟡）——
  { id: 'dev-node', match: ['node_modules'], what: 'Node.js 依赖目录', advice: 'caution', why: '项目依赖。删除后 npm install 可恢复，但项目会无法构建直到重装。确认项目已归档再清。' },
  { id: 'dev-target', match: ['target/debug', 'target/release', 'build/output'], what: '编译产物', advice: 'safe', why: '编译中间产物，重新构建即恢复。' },
  { id: 'dev-gradle', match: ['.gradle'], what: 'Gradle 构建缓存', advice: 'caution', why: '构建缓存+配置。删除后首次构建变慢。' },
  { id: 'dev-maven', match: ['.m2', 'repository'], what: 'Maven 仓库缓存', advice: 'caution', why: '依赖缓存，删除后全量重下。' },

  // —— 下载残留（🟢）——
  { id: 'dl-part', match: ['.crdownload', '.part', '.tmp', '.downloading'], what: '未完成下载', advice: 'safe', why: '浏览器下载中断的残留，确认下载已放弃可清理。' },
  { id: 'dl-dup', match: [' (1)', ' (2)', '- 副本', '-新'], what: '重复下载副本', advice: 'caution', why: '文件名带序号/副本——大概率是重复下载。对照原文件确认内容一致再删。' },

  // —— 微信/QQ（🟡）——
  { id: 'wx-files', match: ['wechat files', 'weixin files', '微信文件'], what: '微信聊天文件', advice: 'caution', why: '聊天记录里的图片/视频/文件！删除前确认没有要保留的（微信内可另存）。' },
  { id: 'qq-files', match: ['qq files', 'qqfile', 'tencent files'], what: 'QQ 聊天文件', advice: 'caution', why: 'QQ 聊天记录文件，同上。' },

  // —— 其他常见（🟡）——
  { id: 'model-ai', match: ['.gguf', '.safetensors', '.ckpt', '.pth', '.onnx'], what: 'AI 模型文件', advice: 'caution', why: '大模型权重（通常几 GB~几十 GB）。删除需重新下载，确认不用了再清。' },
  { id: 'font', match: ['.ttf', '.otf'], what: '字体文件', advice: 'caution', why: '安装的字体。删除后文档显示会变。' },
  { id: 'recycle', match: ['$recycle.bin', 'recycled'], what: '回收站存储', advice: 'danger', why: '系统回收站数据，请通过清空回收站操作。' },
  { id: 'pkg-cache', match: ['pip cache', 'npm-cache', 'nuget', 'cargo registry', 'go pkg'], what: '包管理器缓存', advice: 'safe', why: '下载缓存，删除后需要时重新下载。' },
  { id: 'installer-cache', match: ['cachewindowsinstaller', 'c:\\windows\\installer'], what: 'Windows Installer 缓存', advice: 'danger', why: '已装软件的修复/卸载数据！删除会导致软件无法卸载/修复。' },
  { id: 'video-raw', match: ['.mp4', '.mkv', '.avi', '.mov', '.ts'], what: '视频文件', advice: 'caution', why: '个人视频。是否还需要只有你自己知道——建议在媒体页预览确认。' },
  { id: 'img-raw', match: ['.psd', '.ai', '.raw', '.cr2', '.nef', '.arw'], what: '设计源文件/相机底片', advice: 'caution', why: '创作源文件或原始底片，无法重新获得。谨慎！' },
  { id: 'db-file', match: ['.sql', '.db', '.sqlite', '.mdb'], what: '数据库文件', advice: 'caution', why: '数据文件，删除 = 数据丢失。' },
  { id: 'pdf-doc', match: ['.pdf'], what: 'PDF 文档', advice: 'caution', why: '文档资料，是否需要自判。' }
]

/** 文件名匹配（小写化；glob * 支持） */
export function ruleMatches(rule: KbRule, fileName: string): boolean {
  const n = fileName.toLowerCase()
  return rule.match.some((m) => {
    if (m.includes('*')) {
      const re = new RegExp('^' + m.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      return re.test(n)
    }
    return n.includes(m)
  })
}

/** 知识库版本（在线更新对比用） */
export const KB_VERSION = '2026-10-24.1'
