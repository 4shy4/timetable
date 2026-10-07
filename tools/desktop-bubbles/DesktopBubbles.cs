// Windows 桌面「气泡区」—— 把 App 里那块气泡区**整块**搬到桌面上。
//
// ⚠️⚠️ 形态是用户第 41 轮亲口定的，别再自己"改良"：
//   原话："我就是要铺满全屏的透明层，只不过我要气泡区的模式，有双击，有长按，有单击，
//          有母泡泡背景（这次就得像你之前那样搞一个圈圈，拿出去就拿到平级了），
//          只不过背景我要虚化而不挡住壁纸。桌面气泡的显示与软件气泡区设置保持一致"
//
//   翻译成这个文件要做的事：
//     ① **铺满全屏的透明层**：全屏、无边框、背景全透明；空白处**点透**给桌面，
//        所以桌面和别的软件照常能点、能拖。
//     ② **和软件气泡区一模一样的手势**（对齐 web/ui/views/bubble.js）：
//          · 单击泡泡    = 编辑（浏览器打开那一条，`?open=<id>`）
//          · 双击泡泡    = 进到它里面（套娃）；最小档（蓝）双击只抖一下
//          · 长按 2.5 秒  = 戳破（POST /api/events/<id>/pop，子气泡会被放出来）
//          · 拖泡泡压到别的泡泡上 = 放进去（能不能进由 core 算好的 childLevels 决定）
//          · 容器里单击背景 = 加子气泡（浏览器 `?addChild=<id>`）
//          · 容器里双击背景 = 出去一层
//     ③ **母泡泡背景就是一个圈圈**：进了容器就画一个圆（几何和网页的 parentBubbleGeom
//        完全一样：圆心在画布中心偏下 6、半径 = 短边 × 42%），泡泡只在这个圈里飘；
//        **把子泡泡拖到圈外松手 = 拉出来，和母泡泡平级**。
//     ④ **背景虚化**：圈里那块是"真的被模糊过的壁纸"（不是盖一层半透明深色），
//        所以壁纸还在、只是虚的 —— 这就是"不挡住壁纸"。
//     ⑤ **显示与软件保持一致**：画什么全由 core/desktop-bubbles.js 决定，
//        它读的是 `settings.bubbleView`（就是网页气泡区那三个开关）。
//
// ⚠️ 上一版做成了"一块 520×760 的磨砂面板"，用户否掉了。别退回去。
//
// ⚠️ 这个文件的规矩（和 iOS 壳一字不差）：**原生只画，不做业务判断。**
//   "哪些泡泡该浮出来、多大、什么颜色、文字写什么、过没过期、谁能装下谁"
//   全部由服务端用同一份 core 算好。绝不在 C# 里重写"还剩多久 / 红>黄>绿>蓝"。
//
// ⚠️ 这个形态带回来一个必须记住的坑（第 40 轮踩过一次）：
//   `WM_NCHITTEST` 给的坐标是**物理像素**，而 WPF 的坐标是 **DIP**。
//   这台机器是 150% 缩放，两者差 1.5 倍 —— 不换算就"处处判成没点到"，
//   于是全部返回 HTTRANSPARENT：**泡泡点不动、背景也点不动**（用户报的"完全无法点击"）。
//   换算在 `HitMath.ToDip`，由 `--hittest=` + 一条测试钉着。
//
// ⚠️ 性能（实测数字，别凭感觉调）：
//   这一层是"铺满全屏的透明窗口"，WPF 的 layered window 是**软件合成**的，
//   泡泡里又有十几个渐变/阴影元素 —— 不缓存的话每漂一下就把整棵树重新软渲染一遍：
//   实测 25 帧/秒吃满一个核（~88% CPU）。给每颗泡泡加 `BitmapCache` 之后：
//   10 帧/秒 ≈ 17% 单核、20 帧/秒 ≈ 38%（基本和帧率成正比 = 瓶颈是整屏合成）。
//   改这里的帧率/画法之前，先量一遍：`Get-Process DesktopBubbles | Select CPU`。
//   真要再往下压，下一步是结构性的：**每颗泡泡一个小的分层窗口**（DWM 硬件合成，
//   移动窗口几乎不花 CPU），代价是窗口管理和 z 序会复杂一大截 —— 现在还没到那一步。
//
// 编译：node tools/desktop-bubbles.mjs --build
//   （用系统自带的 csc + .NET Framework 4.8 的 WPF，不需要装任何东西）

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using Microsoft.Win32;
// 托盘图标（系统托盘那个菜单）用 WinForms 的 NotifyIcon —— 现成的，在 WPF 里也能用。
// ⚠️ **不要** `using System.Drawing;`：那会和 WPF 的 Point / Color / Brushes 撞名。
using Forms = System.Windows.Forms;
// ⚠️ `System.IO` 和 `System.Windows.Shapes` 里都有 `Path` → 不写这行会 CS0104
using IOPath = System.IO.Path;

namespace TimetableDesktop
{
    // ---------------------------------------------------------------------
    // 服务端给的契约（字段名就是 JSON 里的名字，**别改大小写** —— 这是两端的接口）
    // ⚠️ 和 core/desktop-bubbles.js 的输出**一个不多一个不少**，
    //    由 tools/desktop-bubbles.test.mjs 那条"两端字段必须一致"钉着。
    // ---------------------------------------------------------------------
    public class BubbleDto
    {
        public string id { get; set; }
        public string key { get; set; }
        public string title { get; set; }
        public string countdown { get; set; }
        public string when { get; set; }
        public string location { get; set; }
        public double r { get; set; }
        public double seed { get; set; }
        public string fill { get; set; }
        public string fillLight { get; set; }
        public string fillDark { get; set; }
        public string edge { get; set; }
        public string text { get; set; }
        public string ring { get; set; }
        public bool overdue { get; set; }
        public bool ownOverdue { get; set; }
        public bool inheritedOverdue { get; set; }
        public string levelKey { get; set; }
        public bool dimmed { get; set; }
        /// <summary>双击能不能进去（蓝色最小档装不下东西 → false）</summary>
        public bool canHold { get; set; }
        /// <summary>哪几档等级能放进它里面（core 的 allowedChildLevels 算好的）</summary>
        public List<string> childLevels { get; set; }
        /// <summary>这颗事件**能改成哪几档**（快速编辑框照着它画按钮；规则在 core）</summary>
        public List<string> levelOptions { get; set; }
        /// <summary>这一颗是哪个日期的实例（戳破要按实例记账）</summary>
        public string occurrence { get; set; }
        /// <summary>戳破时还剩多久（core 算的，原生只是回传）</summary>
        public double? remainingMs { get; set; }
    }

    public class CanvasDto { public double width { get; set; } public double height { get; set; } }

    public class PathDto
    {
        public string id { get; set; }
        public string title { get; set; }
        public string levelKey { get; set; }
        public string fill { get; set; }
    }

    /// <summary>当前这一层的"母泡泡"（那个圈圈）。</summary>
    public class ContainerDto
    {
        public string id { get; set; }
        public string title { get; set; }
        public string levelKey { get; set; }
        public string fill { get; set; }
        public string fillLight { get; set; }
        public string fillDark { get; set; }
        public string edge { get; set; }
        public bool overdue { get; set; }
        public bool readOnly { get; set; }
        /// <summary>往这个容器里新建子气泡时能选哪几档（core 算好的）</summary>
        public List<string> childLevels { get; set; }
        /// <summary>拖出去之后落到哪一层（null = 最外层）。提示文字用它。</summary>
        public string escapeTo { get; set; }
    }

    /// <summary>四档等级（键/名字/颜色）—— 由 core 给，原生不自己抄颜色</summary>
    public class LevelDto
    {
        public string key { get; set; }
        public string label { get; set; }
        public string color { get; set; }
    }

    /// <summary>快速编辑框要读一条事件的原始字段（start/end/notes 这些不在气泡 payload 里）</summary>
    public class EventDto
    {
        public string id { get; set; }
        public string title { get; set; }
        public string start { get; set; }
        public string end { get; set; }
        public string level { get; set; }
        public string tier { get; set; }
        public string location { get; set; }
        public string notes { get; set; }
        public string parentId { get; set; }
    }

    public class StateDto
    {
        public List<EventDto> events { get; set; }
    }

    public class ViewDto
    {
        public string parentId { get; set; }
        public List<PathDto> path { get; set; }
        public ContainerDto container { get; set; }
        public string hint { get; set; }
    }

    /// <summary>原生要说的那几句人话（由 core 给：规则变了解释也跟着变）。</summary>
    public class MessagesDto
    {
        public string cannotEnterLeaf { get; set; }
        public string cannotEnterLeafBody { get; set; }
        public string cannotNest { get; set; }
        public string cannotNestOverdue { get; set; }
        public string nested { get; set; }
        public string escaped { get; set; }
        public string pop { get; set; }
    }

    public class PayloadDto
    {
        public string generatedAt { get; set; }
        public int count { get; set; }
        public CanvasDto canvas { get; set; }
        /// <summary>四档等级表（快速编辑框画按钮用）</summary>
        public List<LevelDto> levels { get; set; }
        public ViewDto view { get; set; }
        public MessagesDto messages { get; set; }
        public List<BubbleDto> bubbles { get; set; }
    }

    class Options
    {
        public string Url = "http://127.0.0.1:7080";
        public int IntervalSec = 60;
        public string SelfTest = null;
        public string HitTest = null;
        /// <summary>直接以"已经在某个母泡泡里"启动（排查/自检用：不用手点就能看那个圈画得对不对）</summary>
        public string Parent = null;
        /// <summary>把**这一层自己渲染的**内容存成 PNG 然后退出（排查用；不是截屏，不碰用户的桌面）</summary>
        public string Shot = null;
        /// <summary>启动时就打开某条日程的编辑框（排查/自检用；配合 --shot 能一起看两张图）</summary>
        public string EditId = null;
        /// <summary>`--clickprobe=&lt;文件&gt;`：开一个能被点的目标窗口，用来验"点透"（见 ClickProbe）</summary>
        public string ClickProbe = null;
        /// <summary>`--simdblclick=x,y[,间隔ms]`：在指定物理坐标上合成一次双击（排查手感用）</summary>
        public string SimDblClick = null;
        /// <summary>`--clickat=x,y[,次数[,间隔ms]]`：合成点击（见 ClickProbe.ClickAt）</summary>
        public string ClickAt = null;
        /// <summary>`--logpositions`：把每颗泡泡的物理坐标写进日志（配合 --simdblclick 做端到端自检）</summary>
        public bool LogPositions = false;
        /// <summary>置顶（默认**开**）。关掉（--desktop-only）就只在"看桌面"时看得见。</summary>
        public bool Topmost = true;
        /// <summary>命令行里**显式**给过置顶相关的开关没有（给过就以它为准，没给就用记住的那个）</summary>
        public bool TopmostGiven = false;
        /// <summary>空白处也吃点击（默认**关** = 点透给桌面）。开了之后整个屏幕都归气泡区，
        /// 但桌面就点不动了 —— 所以默认关，只在托盘菜单里切。</summary>
        public bool CaptureBackground = false;
        /// <summary>--probe-desktop 打印桌面窗口结构（排查用）</summary>
        public bool ProbeDesktop = false;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            foreach (var a in args)
            {
                if (a.StartsWith("--url=")) o.Url = a.Substring(6).TrimEnd('/');
                else if (a.StartsWith("--interval=")) o.IntervalSec = Math.Max(10, int.Parse(a.Substring(11)));
                else if (a.StartsWith("--selftest=")) o.SelfTest = a.Substring(11);
                else if (a.StartsWith("--hittest=")) o.HitTest = a.Substring(10);
                else if (a.StartsWith("--parent=")) o.Parent = a.Substring(9);
                else if (a.StartsWith("--shot=")) o.Shot = a.Substring(7);
                else if (a.StartsWith("--edit=")) o.EditId = a.Substring(7);
                else if (a.StartsWith("--clickprobe=")) o.ClickProbe = a.Substring(13);
                // ⚠️ 数清楚：`--simdblclick=` 是 **14** 个字符。我第一版写了 13，
                //    于是解析出来是 "=84,162" → int.Parse 抛异常 → 进程当场死掉；
                //    winexe 又没有控制台，看起来就是"这个测试什么都没发生"。
                //    排查工具自己出错最坑：它会让我得出"功能是坏的"这种错结论。
                else if (a.StartsWith("--simdblclick=")) o.SimDblClick = a.Substring(14);
                else if (a.StartsWith("--clickat=")) o.ClickAt = a.Substring(10);
                else if (a == "--logpositions") o.LogPositions = true;
                else if (a == "--topmost") { o.Topmost = true; o.TopmostGiven = true; }
                else if (a == "--desktop-only") { o.Topmost = false; o.TopmostGiven = true; }
                else if (a == "--capture-background") o.CaptureBackground = true;
                else if (a == "--probe-desktop") o.ProbeDesktop = true;
            }
            return o;
        }
    }

    /// <summary>
    /// 用户选过的两个开关（关掉再开还是那样）。存在 build/desktop-bubbles.json。
    /// ⚠️ 全屏层没有"位置/大小"可记，所以这里只有两个布尔。
    /// </summary>
    class LayerConfig
    {
        public bool topmost { get; set; }
        public bool captureBackground { get; set; }

        static string FilePath()
        {
            var dir = IOPath.GetFullPath(IOPath.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "build"));
            try { Directory.CreateDirectory(dir); } catch { /* ignore */ }
            return IOPath.Combine(dir, "desktop-bubbles.json");
        }

        public static LayerConfig Load()
        {
            try
            {
                if (File.Exists(FilePath()))
                {
                    var ser = new JavaScriptSerializer();
                    var cfg = ser.Deserialize<LayerConfig>(File.ReadAllText(FilePath(), Encoding.UTF8));
                    if (cfg != null) return cfg;
                }
            }
            catch { /* 配置坏了就当没有 */ }
            return new LayerConfig { topmost = true, captureBackground = false };
        }

        public void Save()
        {
            try
            {
                var ser = new JavaScriptSerializer();
                File.WriteAllText(FilePath(), ser.Serialize(this), Encoding.UTF8);
            }
            catch { /* 存不了不影响使用 */ }
        }
    }

    // -------------------------------------------------------------------------
    // 命中判定：**物理像素 → DIP** + "这个点在不在能点的东西上"
    //
    // ⚠️⚠️ 第一段是"整个功能不可用"级别的，别删：
    //   `WM_NCHITTEST` 给的 lParam 是**物理像素**，WPF 里所有坐标都是 **DIP**。
    //   150% 缩放的屏幕上两者差 1.5 倍 —— 不换算就每一个点都判成"不在泡泡上"，
    //   于是全部 HTTRANSPARENT：泡泡点不动、背景也点不动（用户报的"完全无法点击"）。
    //
    // 做成**纯函数**（不碰窗口）是为了能用 `--hittest=` 直接测：
    // 测的就是跑着的同一份代码，不是它的复制品。
    // -------------------------------------------------------------------------
    static class HitMath
    {
        /// <summary>物理像素 → DIP（scale = 系统缩放，1.5 = 150%）</summary>
        public static Point ToDip(double physX, double physY, double scale)
        {
            var s = scale > 0.01 ? scale : 1.0;
            return new Point(physX / s, physY / s);
        }

        /// <summary>DIP → 物理像素（反着用：排查时把两边都打出来对照）</summary>
        public static Point ToPhys(double dipX, double dipY, double scale)
        {
            var s = scale > 0.01 ? scale : 1.0;
            return new Point(dipX * s, dipY * s);
        }
    }

    /// <summary>一个能点的圆（泡泡；位置由窗口实时维护）</summary>
    class HitTarget
    {
        public string Id;
        public double X, Y, R;
    }

    class HitResult
    {
        /// <summary>bubble / background / none</summary>
        public string Kind;
        public string Id;
    }

    static class HitTest
    {
        /// <summary>母泡泡那个圈的几何 —— 和网页 `parentBubbleGeom` **同一个公式**</summary>
        public static void CircleGeom(double canvasW, double canvasH, out Point center, out double r)
        {
            center = new Point(canvasW / 2, canvasH / 2 + 6);
            r = Math.Min(canvasW, canvasH) * 0.42;
        }

        /// <summary>
        /// 判定顺序（和窗口那边一致）：
        ///   ① 落在某颗泡泡上 → bubble（从后往前 = 后画的在上面）
        ///   ② 在容器里、且落在母泡泡那个圈里 → background（**背景 = 母泡泡**，能点）
        ///   ③ 其它 → none（点透给桌面/别的软件）
        /// </summary>
        public static HitResult Classify(double x, double y, List<HitTarget> targets,
            bool hasCircle, Point circleCenter, double circleR)
        {
            if (targets != null)
            {
                for (var i = targets.Count - 1; i >= 0; i -= 1)
                {
                    var t = targets[i];
                    var dx = x - t.X;
                    var dy = y - t.Y;
                    var r = Math.Max(14, t.R);
                    if (dx * dx + dy * dy <= r * r) return new HitResult { Kind = "bubble", Id = t.Id };
                }
            }
            if (hasCircle)
            {
                var dx = x - circleCenter.X;
                var dy = y - circleCenter.Y;
                if (dx * dx + dy * dy <= circleR * circleR) return new HitResult { Kind = "background", Id = null };
            }
            return new HitResult { Kind = "none", Id = null };
        }
    }

    /// <summary>
    /// `--hittest=物理X,物理Y[,缩放]` —— 拿**固定版面**跑一遍命中判定并打印 JSON。
    ///
    /// 为什么要有它：命中判定错了的表现是"什么都点不动"，而在真桌面上一眼分不出
    /// 是"没命中"还是"窗口没收到输入"。有一份可断言的输出，测试就能把
    /// "物理像素必须换算成 DIP"这件事钉死（不换算时同一个点会判成别的东西）。
    ///
    /// 合成版面：画布 1706×1066 DIP（= 这台机器 150% 下的逻辑尺寸）、
    /// 一颗泡泡在 DIP(400,300) 半径 80，并且**处在容器里**（圈心 853,539 / 半径 447.66）。
    /// </summary>
    static class HitProbe
    {
        public static string Run(string spec)
        {
            var parts = (spec ?? "").Split(',');
            if (parts.Length < 2) return "{\"error\":\"用法 --hittest=物理X,物理Y[,缩放]\"}";
            var px = double.Parse(parts[0].Trim(), CultureInfo.InvariantCulture);
            var py = double.Parse(parts[1].Trim(), CultureInfo.InvariantCulture);
            var scale = parts.Length > 2 ? double.Parse(parts[2].Trim(), CultureInfo.InvariantCulture) : 1.0;

            var dip = HitMath.ToDip(px, py, scale);
            const double W = 1706, H = 1066;
            Point c;
            double cr;
            HitTest.CircleGeom(W, H, out c, out cr);
            var targets = new List<HitTarget>();
            targets.Add(new HitTarget { Id = "probe-bubble", X = 400, Y = 300, R = 80 });
            var hit = HitTest.Classify(dip.X, dip.Y, targets, true, c, cr);

            var d = new Dictionary<string, object>();
            d["hit"] = hit.Kind;
            d["bubbleId"] = hit.Id;
            d["scale"] = scale;
            d["dip"] = new Dictionary<string, object> { { "x", Math.Round(dip.X, 2) }, { "y", Math.Round(dip.Y, 2) } };
            d["circle"] = new Dictionary<string, object> {
                { "x", Math.Round(c.X, 2) }, { "y", Math.Round(c.Y, 2) }, { "r", Math.Round(cr, 2) } };
            return new JavaScriptSerializer().Serialize(d);
        }
    }

    // -------------------------------------------------------------------------
    // 入口
    // -------------------------------------------------------------------------
    class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            var opt = Options.Parse(args);
            if (opt.SelfTest != null)
            {
                // 不开窗口、不抓屏，把**整层**渲染成一张 PNG —— 让"画得对不对"可验证
                SelfTest.Render(opt.SelfTest);
                return;
            }
            if (opt.HitTest != null)
            {
                Console.WriteLine(HitProbe.Run(opt.HitTest));
                return;
            }
            if (opt.ProbeDesktop)
            {
                // 打印桌面的窗口结构。留着它是因为"贴到图标之下"那个方向就是靠它否掉的。
                Console.WriteLine(Win32.DescribeDesktop());
                return;
            }
            if (opt.ClickProbe != null)
            {
                // 排查用：开一个"能被点的小窗口"，用来验上面那一层到底有没有把点击放过去
                ClickProbe.Run(opt.ClickProbe);
                return;
            }
            if (opt.ClickAt != null)
            {
                ClickProbe.ClickAt(opt.ClickAt);
                return;
            }
            if (opt.SimDblClick != null)
            {
                // 排查用：在指定坐标合成一次双击（验"双击到底稳不稳"）
                ClickProbe.SimDblClick(opt.SimDblClick);
                return;
            }
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var win = new BubbleLayer(opt);
            // 托盘图标：这一层是"点透"的，所以托盘是最可靠的入口（不受 z 序影响）
            var tray = TrayMenu.Attach(win);
            win.Closed += (s, e) => { try { tray.Dispose(); } catch { /* ignore */ } };
            app.Run(win);
        }
    }

    // -------------------------------------------------------------------------
    // 托盘图标
    // -------------------------------------------------------------------------
    static class TrayMenu
    {
        public static Forms.NotifyIcon Attach(BubbleLayer win)
        {
            var menu = new Forms.ContextMenuStrip();
            menu.Items.Add(Make("打开日程表（浏览器）", () => win.OpenApp()));
            menu.Items.Add(new Forms.ToolStripSeparator());
            // ⚠️ 这两个开关要做成**带勾的**，不能写成"…（开/关）"：
            //    上一版托盘上写的是"空白处点透桌面（开/关）"，而它翻的是
            //    `captureBackground` —— 字面和动作**正好相反**，点一下就把整个桌面
            //    变成点不动的（用户差点踩到）。带勾的菜单项没有这种歧义。
            menu.Items.Add(Check("浮在所有窗口之上", () => win.IsTopmost(), () => win.MenuToggleTopmost()));
            menu.Items.Add(Check("空白处也吃点击（不勾 = 点透桌面）", () => win.IsCapturing(), () => win.MenuToggleCapture()));
            menu.Items.Add(Make("回到最外层（从母泡泡里出来）", () => win.MenuRoot()));
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add(Make("立即刷新", () => win.MenuRefresh()));
            menu.Items.Add(Make("重排位置", () => win.MenuReshuffle()));
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add(Make("退出桌面气泡区", () => win.MenuQuit()));

            var icon = new Forms.NotifyIcon
            {
                Icon = System.Drawing.SystemIcons.Application,
                Text = "日程表 · 桌面气泡区",
                Visible = true,
                ContextMenuStrip = menu,
            };
            icon.DoubleClick += (s, e) => win.OpenApp();
            return icon;
        }

        static Forms.ToolStripMenuItem Make(string text, Action onClick)
        {
            var it = new Forms.ToolStripMenuItem(text);
            it.Click += (s, e) => onClick();
            return it;
        }

        /// <summary>带勾的开关：每次弹出菜单时按当前状态刷新勾（状态可能在别处被改）</summary>
        static Forms.ToolStripMenuItem Check(string text, Func<bool> isOn, Action toggle)
        {
            var it = new Forms.ToolStripMenuItem(text);
            it.Click += (s, e) => { toggle(); it.Checked = isOn(); };
            it.DropDownOpening += (s, e) => { it.Checked = isOn(); };
            return it;
        }
    }

    // -------------------------------------------------------------------------
    // 桌面图标的位置（用户第 46 轮的要求："只有桌面空白——没有图标纯壁纸的地方——可点"）
    //
    // ⚠️ 怎么拿到图标位置：走 **UI Automation**（系统无障碍接口），
    //    而不是"往 explorer.exe 里 WriteProcessMemory + LVM_GETITEMRECT"那种野路子 ——
    //    野路子要跨进程写内存（杀软会盯上），explorer 一重启还可能崩。
    //    UIA 是官方读法，代价是**慢**（几十到几百毫秒）。
    //
    // ⚠️ 所以它**必须在后台线程跑**：UI 线程卡一下，整层的漂浮就顿住了。
    //    读不到（UIA 抽风 / 桌面被换 / 权限）就返回**空表** ——
    //    意思是"不扣任何图标区"，宁可退回旧行为，也不要让这一层崩掉。
    // -------------------------------------------------------------------------
    static class DesktopIcons
    {
        public static string LastError = null;
        /// <summary>图标的显示名（和 `Rects()` 一一对应；只用来排查）</summary>
        public static readonly List<string> Names = new List<string>();

        /// <summary>桌面上每个图标的矩形（**物理像素**）；读不到就给空表</summary>
        public static List<int[]> Rects()
        {
            var found = new List<int[]>();
            Names.Clear();
            LastError = null;
            try
            {
                var root = System.Windows.Automation.AutomationElement.RootElement;
                var progman = root.FindFirst(System.Windows.Automation.TreeScope.Children,
                    new System.Windows.Automation.PropertyCondition(
                        System.Windows.Automation.AutomationElement.ClassNameProperty, "Progman"));
                if (progman == null) { LastError = "没找到 Progman"; return found; }

                // Win11 的桌面图标仍然住在 SysListView32 里（挂在 SHELLDLL_DefView 下面）
                var list = progman.FindFirst(System.Windows.Automation.TreeScope.Descendants,
                    new System.Windows.Automation.PropertyCondition(
                        System.Windows.Automation.AutomationElement.ClassNameProperty, "SysListView32"));
                if (list == null) { LastError = "没找到 SysListView32"; return found; }

                var items = list.FindAll(System.Windows.Automation.TreeScope.Children,
                    System.Windows.Automation.Condition.TrueCondition);
                foreach (System.Windows.Automation.AutomationElement it in items)
                {
                    var r = it.Current.BoundingRectangle;
                    if (r.Width < 2 || r.Height < 2) continue;      // 隐藏/折叠的项
                    found.Add(new[] { (int)r.Left, (int)r.Top, (int)r.Right, (int)r.Bottom });
                    // 名字只用来排查：日志里看几个名字就能判断"读到的到底是不是真图标"
                    // ⚠️ C# 里没有 `String(x)` 这种转换写法（写成那样会 CS0118）
                    try { Names.Add(it.Current.Name ?? ""); } catch { Names.Add("(无名)"); }
                }
            }
            catch (Exception ex)
            {
                LastError = ex.GetType().Name + ": " + ex.Message;
            }
            return found;
        }
    }

    // -------------------------------------------------------------------------
    // Win32：桌面结构探针（留着排查）+ 可见窗口矩形 + 光标位置
    // -------------------------------------------------------------------------
    static class Win32
    {
        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr FindWindow(string cls, string win);
        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string win);
        [DllImport("user32.dll")]
        static extern int GetClassName(IntPtr hWnd, StringBuilder buf, int max);
        [DllImport("user32.dll")]
        static extern bool EnumWindows(EnumProc cb, IntPtr param);
        delegate bool EnumProc(IntPtr hWnd, IntPtr param);

        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out POINT p);
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [DllImport("user32.dll", SetLastError = true)]
        static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll", SetLastError = true)]
        static extern int SetWindowLong(IntPtr hWnd, int index, int value);

        const int GWL_EXSTYLE = -20;
        const int WS_EX_TRANSPARENT = 0x00000020;

        public static string ClassOf(IntPtr h)
        {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        /// <summary>光标位置（**物理像素** —— 和 WM_NCHITTEST 的 lParam 同一个坐标系）</summary>
        public static bool Cursor(out double x, out double y)
        {
            POINT p;
            var ok = GetCursorPos(out p);
            x = p.X;
            y = p.Y;
            return ok;
        }

        /// <summary>
        /// 打开/关闭 `WS_EX_TRANSPARENT` —— **现在没人调用了**（点透改用 `HTTRANSPARENT`，见 WndProc）。
        /// 留着是因为排查"点透"时可能要对照着试（`--clickprobe` 那套实验）。
        /// </summary>
        public static void SetClickThrough(IntPtr hwnd, bool on)
        {
            try
            {
                if (hwnd == IntPtr.Zero) return;
                var cur = GetWindowLong(hwnd, GWL_EXSTYLE);
                var next = on ? (cur | WS_EX_TRANSPARENT) : (cur & ~WS_EX_TRANSPARENT);
                if (next != cur) SetWindowLong(hwnd, GWL_EXSTYLE, next);
            }
            catch { /* 改不了就退回 NCHITTEST 那一套 */ }
        }

        /// <summary>
        /// 屏幕上"**不属于桌面空白**"的矩形（**物理像素**）：别的可见窗口 + 任务栏。
        ///
        /// ⚠️ 为什么要扣掉它们：这一层是置顶的，如果不扣，用户点浏览器/记事本的那一下
        ///    会被我们吃掉 —— 那就是"整屏都在抢点击"，正是用户不要的那种行为。
        ///    用户要的是"**纯壁纸**的地方可点"，所以有窗口盖住的地方一律不算壁纸。
        ///
        /// 排除掉：桌面自己（Progman / WorkerW / SHELLDLL_DefView）—— 它是"壁纸本身"；
        ///         我们这个进程的窗口（自己人）。
        /// 保留（= 要扣掉）：任务栏（Shell_TrayWnd，点它不该被我们抢）、以及其它所有可见窗口。
        /// </summary>
        public static List<int[]> BlockingWindowRects(IntPtr self)
        {
            var found = new List<int[]>();
            uint selfPid = 0;
            try { GetWindowThreadProcessId(self, out selfPid); } catch { /* ignore */ }
            EnumWindows((h, p) =>
            {
                try
                {
                    if (!IsWindowVisible(h)) return true;
                    var cls = ClassOf(h);
                    if (cls == "Progman" || cls == "WorkerW" || cls == "SHELLDLL_DefView") return true;
                    if (cls == "Windows.UI.Core.CoreWindow") return true;      // 各种输入法/浮层
                    uint pid;
                    GetWindowThreadProcessId(h, out pid);
                    if (selfPid != 0 && pid == selfPid) return true;            // 自己的窗口
                    if (IsIconic(h)) return true;                               // 最小化的不算占地方
                    RECT r;
                    if (!GetWindowRect(h, out r)) return true;
                    if (r.Right - r.Left < 8 || r.Bottom - r.Top < 8) return true;
                    found.Add(new[] { r.Left, r.Top, r.Right, r.Bottom });
                }
                catch { /* 单个窗口读失败不影响其它 */ }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        /// <summary>窗口在屏幕上的**物理**矩形（排查"点到底落在哪"用）</summary>
        public static string RectOf(IntPtr hwnd)
        {
            try
            {
                RECT r;
                if (!GetWindowRect(hwnd, out r)) return "(取不到)";
                return r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top);
            }
            catch { return "(出错)"; }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

        /// <summary>`--probe-desktop` 用：把桌面的窗口结构打出来</summary>
        public static string DescribeDesktop()
        {
            var sb = new StringBuilder();
            IntPtr defView = IntPtr.Zero;
            var host = IntPtr.Zero;
            EnumWindows((h, p) =>
            {
                var v = FindWindowEx(h, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (v != IntPtr.Zero) { host = h; defView = v; return false; }
                return true;
            }, IntPtr.Zero);
            sb.Append("图标宿主=").Append(host == IntPtr.Zero ? "(没找到)" : ClassOf(host) + "#" + host.ToInt64());
            sb.Append("  SHELLDLL_DefView=").Append(defView == IntPtr.Zero ? "(没找到)" : "#" + defView.ToInt64());
            var progman = FindWindow("Progman", null);
            sb.Append("  Progman=").Append(progman == IntPtr.Zero ? "(没找到)" : "#" + progman.ToInt64());
            sb.Append("\n顶层窗口们：");
            EnumWindows((h, p) =>
            {
                var cls = ClassOf(h);
                if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd")
                {
                    var childCount = 0;
                    var c = FindWindowEx(h, IntPtr.Zero, null, null);
                    while (c != IntPtr.Zero && childCount < 8) { childCount++; c = FindWindowEx(c, IntPtr.Zero, null, null); }
                    sb.Append("\n  ").Append(cls).Append(" #").Append(h.ToInt64())
                      .Append(" 子窗口 ").Append(childCount).Append(" 个");
                }
                return true;
            }, IntPtr.Zero);
            return sb.ToString();
        }
    }


    // -------------------------------------------------------------------------
    // 画一颗泡泡（**静态**方法：主窗口和 selftest 都用它，保证两边一模一样）
    // -------------------------------------------------------------------------
    static class BubbleVisual
    {
        /// <summary>长按进度环的半径倍数（和网页 LONG_PRESS_RING 同一个常数）</summary>
        public const double LONG_PRESS_RING = 1.22;

        /// <summary>
        /// 画一颗泡泡。**尽量和软件里那颗长一样**（用户要求"和软件内的图像保持一致"）——
        /// 网页 canvas 那份的画法（web/ui/views/bubble.js）是：
        ///   1) 软外晕（把泡泡垫在背景上） 2) 受光的球体（左上亮、右下暗）
        ///   3) 边缘光带 4) 大高光 + 小高光（真实反射） 5) 底部内暗影
        ///   6) 过期 → 暗紫 + 向内的刺；只有祖先过期 → 一圈暗紫虚线环
        /// 这里逐条对上（原生用 WPF 的渐变/形状，几何上用同一套比例常数）。
        /// </summary>
        public static Grid Build(BubbleDto d)
        {
            // ⚠️ 外晕/高光都要超出泡体，所以画布要比泡大一圈（和 canvas 那边一样）
            var r = Math.Max(14, d.r);
            var size = r * 2.7;
            var grid = new Grid { Width = size, Height = size };
            // ⚠️⚠️ 必须缓存成位图（实测数字，改之前先量）：
            //    这一层是"铺满全屏的透明窗口"，WPF 的 layered window 是**软件合成**的，
            //    而一颗泡泡里有十几个渐变/阴影元素。不缓存的话泡泡每漂一下就把整棵树
            //    重新软渲染一遍 —— 25 帧/秒时实测吃满一个核（~88% CPU）；
            //    加上这行之后同样的帧率降到 ~17%。
            grid.CacheMode = new BitmapCache();
            var c = size / 2;                       // 圆心（都是相对坐标）
            var baseCol = Col(d.fill);
            var t = new TranslateTransform(0, 0);
            grid.RenderTransform = t;               // 抖一下（拒绝时）就动这个

            // 0) 过期的刺先算出来，但**要等泡体画完再叠上去**。
            //    ⚠️ 网页那份是把刺画在泡体**下面**、靠泡体 0.88 的半透明透出来；
            //    这里泡体是不透明的，画在下面就等于白画（第一次渲染自检里那颗紫泡泡
            //    光秃秃的，就是因为刺被泡体整个盖住了）。所以这里改成叠在泡体之上、
            //    稍微降一点不透明度 —— 读起来和网页一样是"一圈扎进泡里的紫刺"。
            FrameworkElement spikes = d.overdue ? Spikes(r, 13, 0.16) : null;

            // 1) 软外晕
            var glow = new Ellipse { Width = r * 2.3, Height = r * 2.3, IsHitTestVisible = false };
            var gg = new RadialGradientBrush();
            gg.GradientStops.Add(new GradientStop(Color.FromArgb(60, baseCol.R, baseCol.G, baseCol.B), 0.62));
            gg.GradientStops.Add(new GradientStop(Color.FromArgb(0, baseCol.R, baseCol.G, baseCol.B), 1.0));
            glow.Fill = gg;
            glow.HorizontalAlignment = HorizontalAlignment.Center;
            glow.VerticalAlignment = VerticalAlignment.Center;
            grid.Children.Add(glow);

            // 2) 泡体：左上受光的球体（往白里混 42% / 往深里混 45% —— 和网页同一个配方）
            var body = new Ellipse
            {
                Width = r * 2, Height = r * 2,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            body.Fill = BodyBrush(d);
            body.Opacity = d.dimmed ? 0.55 : 1.0;
            grid.Children.Add(body);

            // 3) 边缘光带：很薄的一圈浅色（不是实心粗亮环）
            var rim = new Ellipse
            {
                Width = r * 2, Height = r * 2,
                StrokeThickness = Math.Max(1, r * 0.035),
                IsHitTestVisible = false,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            var rimG = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(1, 1) };
            rimG.GradientStops.Add(new GradientStop(Color.FromArgb(150, 255, 255, 255), 0.0));
            rimG.GradientStops.Add(new GradientStop(Color.FromArgb(0, 255, 255, 255), 0.55));
            rimG.GradientStops.Add(new GradientStop(Color.FromArgb(70, 255, 255, 255), 1.0));
            rim.Stroke = rimG;
            grid.Children.Add(rim);

            // 4) 两个高光：大的柔光斑（左上）+ 很小的细点（真实反射）
            var big = new Ellipse
            {
                Width = r * 0.72, Height = r * 0.5, IsHitTestVisible = false,
                HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(c - r * 0.62, c - r * 0.72, 0, 0),
            };
            var bg = new RadialGradientBrush();
            bg.GradientStops.Add(new GradientStop(Color.FromArgb(130, 255, 255, 255), 0.0));
            bg.GradientStops.Add(new GradientStop(Color.FromArgb(0, 255, 255, 255), 1.0));
            big.Fill = bg;
            big.RenderTransform = new RotateTransform(-28, r * 0.36, r * 0.25);
            grid.Children.Add(big);

            var dot = new Ellipse
            {
                Width = r * 0.13, Height = r * 0.13, IsHitTestVisible = false,
                Fill = new SolidColorBrush(Color.FromArgb(210, 255, 255, 255)),
                HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(c - r * 0.30, c - r * 0.62, 0, 0),
            };
            grid.Children.Add(dot);

            // 5) 底部内暗影（球的下缘积暗，立体感）
            var shade = new Ellipse
            {
                Width = r * 1.86, Height = r * 1.86, IsHitTestVisible = false,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            var sg = new RadialGradientBrush
            {
                GradientOrigin = new Point(0.5, 0.28), Center = new Point(0.5, 0.28),
                RadiusX = 1.0, RadiusY = 1.0,
            };
            sg.GradientStops.Add(new GradientStop(Color.FromArgb(0, 0, 0, 0), 0.55));
            sg.GradientStops.Add(new GradientStop(Color.FromArgb(46, 11, 18, 32), 1.0));
            shade.Fill = sg;
            grid.Children.Add(shade);

            // 6) 描边：把泡泡从背景里"切"出来（过期用亮紫，平时用很淡的深色）
            var edge = new Ellipse
            {
                Width = r * 2, Height = r * 2, IsHitTestVisible = false,
                Stroke = new SolidColorBrush(Col(d.edge)),
                StrokeThickness = Math.Max(1, r * 0.02),
                Opacity = 0.85,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            grid.Children.Add(edge);

            // 0b) 过期的刺（叠在泡体之上，见上面 0) 的说明）
            if (spikes != null)
            {
                spikes.Opacity = d.dimmed ? 0.5 : 0.82;
                grid.Children.Add(spikes);
            }

            // 7) 只有"祖先过期"时才套的那圈暗紫虚线环（自己没过期）
            if (!string.IsNullOrEmpty(d.ring))
            {
                grid.Children.Add(new Ellipse
                {
                    Width = r * 2.06, Height = r * 2.06,
                    Stroke = new SolidColorBrush(Col(d.ring)),
                    StrokeThickness = Math.Max(2, r * 0.055),
                    StrokeDashArray = new DoubleCollection(new[] { 1.6, 1.3 }),
                    Opacity = 0.9,
                    IsHitTestVisible = false,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center,
                });
            }

            // 8) 文字（和网页一样：标题 + 剩余时间，居中，带柔和描边保证可读）
            var stack = new StackPanel
            {
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                IsHitTestVisible = false,
            };
            var titleSize = Math.Max(11, Math.Min(19, r * 0.30));
            stack.Children.Add(new TextBlock
            {
                Text = d.title,
                FontSize = titleSize,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Col(d.text)),
                TextWrapping = TextWrapping.Wrap,
                TextAlignment = TextAlignment.Center,
                // 给足宽度：太窄会把"大学物理实验作业"折成"…作/业"（渲染自检一眼看得出来）
                MaxWidth = r * 1.74,
                TextTrimming = TextTrimming.CharacterEllipsis,
                MaxHeight = Math.Round(titleSize * 3.4),
                Effect = new DropShadowEffect { Color = Colors.Black, BlurRadius = 3, ShadowDepth = 0, Opacity = 0.5 },
            });
            if (!string.IsNullOrEmpty(d.countdown))
            {
                stack.Children.Add(new TextBlock
                {
                    Text = d.countdown,
                    FontSize = Math.Max(9.5, titleSize * 0.68),
                    Foreground = new SolidColorBrush(Col(d.text)),
                    TextAlignment = TextAlignment.Center,
                    MaxWidth = r * 1.82,
                    Opacity = 0.94,
                    Margin = new Thickness(0, 3, 0, 0),
                    Effect = new DropShadowEffect { Color = Colors.Black, BlurRadius = 3, ShadowDepth = 0, Opacity = 0.5 },
                });
            }
            grid.Children.Add(new Border
            {
                // 很淡的一层垫片：只在深色泡体（过期那种暗紫）上帮白字站住。
                // ⚠️ 不能浓 —— 第一版用 alpha 40，在黄泡泡上就是一块明显的深色补丁
                Background = new SolidColorBrush(Color.FromArgb(20, 11, 18, 32)),
                CornerRadius = new CornerRadius(r * 0.32),
                Padding = new Thickness(6, 4, 6, 4),
                Child = stack,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                MaxWidth = r * 1.86,
                IsHitTestVisible = false,
            });
            return grid;
        }

        /// <summary>
        /// 长按进度环（按住 2.5 秒戳破）。默认收起来，`UpdateHoldRing` 推进。
        /// 和网页同一个半径倍数，所以"环走满"这件事两端读起来一样。
        /// </summary>
        public static System.Windows.Shapes.Path HoldRing(double r)
        {
            return new System.Windows.Shapes.Path
            {
                Width = r * 2.7,
                Height = r * 2.7,
                Stroke = new SolidColorBrush(Color.FromArgb(235, 255, 255, 255)),
                StrokeThickness = Math.Max(2, r * 0.085),
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                IsHitTestVisible = false,
                Visibility = Visibility.Collapsed,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
        }

        /// <summary>推进长按环（progress 0..1）。0 就整个收起来。</summary>
        public static void UpdateHoldRing(System.Windows.Shapes.Path ring, double r, double progress)
        {
            if (ring == null) return;
            if (progress <= 0.001) { ring.Visibility = Visibility.Collapsed; return; }
            ring.Visibility = Visibility.Visible;
            var c = r * 1.35;                       // 泡体在这张 2.7r 的画布里居中
            var rad = r * LONG_PRESS_RING;
            var fig = new PathFigure
            {
                StartPoint = new Point(c, c - rad),
                IsClosed = false,
                IsFilled = false,
            };
            var p = Math.Min(1.0, progress);
            if (p >= 0.999)
            {
                // 整整一圈：ArcSegment 画不出 360°，用一个"几乎回到起点"的弧代替
                fig.Segments.Add(new ArcSegment(new Point(c + 0.01, c - rad),
                    new Size(rad, rad), 0, true, SweepDirection.Clockwise, true));
            }
            else
            {
                var ang = -Math.PI / 2 + p * Math.PI * 2;
                fig.Segments.Add(new ArcSegment(
                    new Point(c + Math.Cos(ang) * rad, c + Math.Sin(ang) * rad),
                    new Size(rad, rad), 0, p > 0.5, SweepDirection.Clockwise, true));
            }
            var geo = new PathGeometry();
            geo.Figures.Add(fig);
            ring.Data = geo;
        }

        /// <summary>
        /// 过期那圈"向内的刺"：沿泡壁 13 根，从壁向圆心收成尖。
        /// ⚠️ 和网页用同一组常数（`OVERDUE_SPIKES = 13`、`OVERDUE_SPIKE_LEN = 0.16`）——
        ///    这是过期最显眼的那个视觉，两边不一致的话用户一眼就看得出来。
        /// </summary>
        static Polygon Spikes(double r, int n, double len)
        {
            var c = r * 1.35;                       // 画布圆心（泡体在 2.7r 的画布里居中）
            double outer = r;
            double inner = r * (1 - len);
            var pts = new PointCollection();
            for (int i = 0; i < n; i++)
            {
                var a0 = (Math.PI * 2 / n) * i - Math.PI / 2;
                var half = Math.PI / n * 0.62;
                pts.Add(new Point(c + Math.Cos(a0 - half) * outer, c + Math.Sin(a0 - half) * outer));
                pts.Add(new Point(c + Math.Cos(a0) * inner, c + Math.Sin(a0) * inner));
                pts.Add(new Point(c + Math.Cos(a0 + half) * outer, c + Math.Sin(a0 + half) * outer));
            }
            var poly = new Polygon
            {
                Points = pts,
                IsHitTestVisible = false,
                Width = r * 2.7,
                Height = r * 2.7,
                Stretch = Stretch.None,
            };
            var g = new RadialGradientBrush
            {
                GradientOrigin = new Point(0.5, 0.5), Center = new Point(0.5, 0.5),
                RadiusX = 0.5, RadiusY = 0.5,
            };
            g.GradientStops.Add(new GradientStop(Color.FromArgb(20, 124, 58, 237), 0.72));
            g.GradientStops.Add(new GradientStop(Color.FromArgb(150, 91, 42, 110), 0.86));
            g.GradientStops.Add(new GradientStop(Color.FromArgb(235, 124, 58, 237), 1.0));
            poly.Fill = g;
            return poly;
        }

        /// <summary>
        /// 母泡泡背景那一个圈：**一层淡淡的颜色**（真的桌面从底下透出来）+ 圈边 + 标题。
        ///
        /// ⚠️⚠️ 这里原来画的是"把系统壁纸读出来、模糊一份、贴在圈里"。
        ///    用户第 43 轮否掉了它，原话："**你别画桌面啊，你只要背景淡化透明就好了啊**"。
        ///    他说得对：那是**一张假的桌面**（位置/图标/别的窗口都对不上，
        ///    刚好壁纸样式不是"填充"时还会错位）—— 看起来就是"这个程序在画我的桌面"。
        ///    正确的做法是**什么都不画**：让**真的桌面**透过一层淡淡的颜色露出来。
        ///    所以这里只有一个低透明度的填充（外加一层更淡的径向柔光），
        ///    壁纸/图标/窗口全都是**真实的那一份**。
        /// </summary>
        public static Canvas BuildParentCircle(ContainerDto c, double w, double h)
        {
            Point center;
            double r;
            HitTest.CircleGeom(w, h, out center, out r);
            var host = new Canvas { Width = w, Height = h, IsHitTestVisible = false };
            var clip = new EllipseGeometry(center, r, r);
            var baseCol = Col(c.fill);

            // ① 淡淡的颜色底（约 12% 不透明度）：把背景**压淡一点**，但不遮住它
            var wash = new Ellipse
            {
                Width = r * 2, Height = r * 2,
                Fill = new SolidColorBrush(Color.FromArgb(32, baseCol.R, baseCol.G, baseCol.B)),
                IsHitTestVisible = false,
            };
            Canvas.SetLeft(wash, center.X - r);
            Canvas.SetTop(wash, center.Y - r);
            host.Children.Add(wash);

            // ② 容器颜色的柔光（和网页 `.bubble-stage.bubble-inside` 的径向渐变一个意思），
            //    非常淡：只用来提示"你在哪个颜色的泡泡里"
            var glow = new Ellipse
            {
                Width = r * 2, Height = r * 2,
                IsHitTestVisible = false,
                Clip = clip,
            };
            var rg = new RadialGradientBrush
            {
                GradientOrigin = new Point(0.5, 0.12), Center = new Point(0.5, 0.12),
                RadiusX = 0.9, RadiusY = 0.7,
            };
            rg.GradientStops.Add(new GradientStop(Color.FromArgb(54, baseCol.R, baseCol.G, baseCol.B), 0.0));
            rg.GradientStops.Add(new GradientStop(Color.FromArgb(26, baseCol.R, baseCol.G, baseCol.B), 0.55));
            rg.GradientStops.Add(new GradientStop(Color.FromArgb(10, baseCol.R, baseCol.G, baseCol.B), 1.0));
            glow.Fill = rg;
            Canvas.SetLeft(glow, center.X - r);
            Canvas.SetTop(glow, center.Y - r);
            host.Children.Add(glow);

            // ③ 圈边（容器过期 → 虚线，和网页 .bubble-inside-overdue 一致）
            var rim = new Ellipse
            {
                Width = r * 2, Height = r * 2,
                Stroke = new SolidColorBrush(Col(c.edge)),
                StrokeThickness = Math.Max(2, r * 0.008),
                Opacity = 0.85,
                IsHitTestVisible = false,
            };
            if (c.overdue) rim.StrokeDashArray = new DoubleCollection(new[] { 3.0, 2.2 });
            Canvas.SetLeft(rim, center.X - r);
            Canvas.SetTop(rim, center.Y - r);
            host.Children.Add(rim);

            // ④ 容器标题：压在圈顶内侧，告诉用户"你在哪个泡泡里面"
            var title = new TextBlock
            {
                Text = c.title,
                FontSize = 15,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Col("#ffffff")),
                TextAlignment = TextAlignment.Center,
                TextWrapping = TextWrapping.NoWrap,
                TextTrimming = TextTrimming.CharacterEllipsis,
                MaxWidth = r * 1.1,
                Effect = new DropShadowEffect { Color = Colors.Black, BlurRadius = 6, ShadowDepth = 0, Opacity = 0.75 },
            };
            title.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            Canvas.SetLeft(title, center.X - title.DesiredSize.Width / 2);
            Canvas.SetTop(title, center.Y - r + Math.Max(14, r * 0.07));
            host.Children.Add(title);

            return host;
        }

        public static RadialGradientBrush BodyBrush(BubbleDto d)
        {
            var g = new RadialGradientBrush
            {
                GradientOrigin = new Point(0.32, 0.28),   // 光从左上打进来（和网页同一个方向）
                Center = new Point(0.32, 0.28),
                RadiusX = 1.15,
                RadiusY = 1.15,
            };
            g.GradientStops.Add(new GradientStop(Col(d.fillLight), 0.0));   // 受光面（往白里混 42%）
            g.GradientStops.Add(new GradientStop(Col(d.fill), 0.55));
            g.GradientStops.Add(new GradientStop(Col(d.fillDark), 1.0));    // 背光面（往深里混 45%）
            return g;
        }

        public static Color Col(string hex)
        {
            try
            {
                if (string.IsNullOrEmpty(hex)) return Colors.White;
                var s = hex.Trim();
                if (s.StartsWith("rgba"))
                {
                    var inner = s.Substring(s.IndexOf('(') + 1).TrimEnd(')');
                    var parts = inner.Split(',');
                    return Color.FromArgb(
                        (byte)Math.Round(double.Parse(parts[3], CultureInfo.InvariantCulture) * 255),
                        byte.Parse(parts[0].Trim()), byte.Parse(parts[1].Trim()), byte.Parse(parts[2].Trim()));
                }
                s = s.TrimStart('#');
                if (s.Length == 3) s = string.Concat(s.Select(ch => new string(ch, 2)));
                var v = uint.Parse(s, NumberStyles.HexNumber);
                return s.Length == 8
                    ? Color.FromArgb((byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v)
                    : Color.FromRgb((byte)(v >> 16), (byte)(v >> 8), (byte)v);
            }
            catch { return Colors.White; }
        }
    }

    // -------------------------------------------------------------------------
    // 主窗口：铺满全屏的透明气泡层
    // -------------------------------------------------------------------------
    /// <summary>
    /// 桌面上的那一层「气泡区」。
    ///
    /// ⚠️ 形态是用户第 41 轮定的（"我就是要铺满全屏的透明层"，但要**气泡区的模式**）：
    ///   · 全屏、无边框、背景**全透明** → 桌面照常看得见
    ///   · 空白处**点透**（HTTRANSPARENT + WS_EX_TRANSPARENT）→ 桌面/别的软件照常能点
    ///   · 泡泡、以及"母泡泡那个圈"能点 → 单击/双击/长按/拖拽，和软件气泡区一样
    ///   · 进了容器：圈里是**模糊的壁纸**（背景虚化但不挡住壁纸）+ 容器色的柔光 + 圈边
    /// </summary>
    class BubbleLayer : Window
    {
        class Live
        {
            public BubbleDto Data;
            public double X, Y, Vx, Vy;
            public double Radius;                     // **泡体**半径（DIP）
            public Grid Root;
            public System.Windows.Shapes.Path Ring;    // 长按进度环
            public bool Dragging;
            public Point Grab;
        }

        const int WM_NCHITTEST = 0x0084;
        const int WM_LBUTTONDOWN = 0x0201;
        const int HTCLIENT = 1;
        const int HTTRANSPARENT = -1;
        /// <summary>长按多久算"戳破"（用户指定 2.5 秒，和网页 LONG_PRESS_MS 同一个值）</summary>
        const double LONG_PRESS_MS = 2500;
        /// <summary>单击/双击的判定窗口**下限**（网页那份用的就是这个值，留给触摸）</summary>
        const double TAP_WINDOW_MS = 330;
        /// <summary>移动超过这么多 DIP 就算"在拖"，不再算轻点（和网页 12px 一致）</summary>
        const double MOVE_SLOP = 12;

        readonly Options _opt;
        readonly LayerConfig _cfg;
        readonly Canvas _stage = new Canvas();
        readonly List<Live> _live = new List<Live>();
        readonly DispatcherTimer _tick = new DispatcherTimer();
        readonly DispatcherTimer _fetch = new DispatcherTimer();
        // ⚠️ 这里原来还有一个 25ms 的"光标轮询"定时器（用 WS_EX_TRANSPARENT 开关点透）。
        //    实测（`--clickprobe` 的 A/B 对照）证明 `HTTRANSPARENT` 跨进程也生效，
        //    而它是**同步**的，所以那套异步轮询被删掉了 —— 它的空窗正是
        //    "双击有时候无响应"的一个来源。详见 WndProc 上面的说明。
        readonly DispatcherTimer _tapTimer = new DispatcherTimer();
        readonly DispatcherTimer _bgTimer = new DispatcherTimer();
        readonly DispatcherTimer _toastTimer = new DispatcherTimer();
        readonly Border _hud;
        readonly TextBlock _hudText = new TextBlock();
        /// <summary>「空白处也吃点击」那层几乎看不见的膜（alpha = 1，带洞）—— 见构造函数里的说明</summary>
        System.Windows.Shapes.Path _veil;
        /// <summary>桌面图标的矩形（物理像素；后台线程读、UI 线程用）</summary>
        List<int[]> _iconRects = new List<int[]>();
        DateTime _lastIconScan = DateTime.MinValue;
        bool _iconScanBusy = false;
        DateTime _lastVeilBuild = DateTime.MinValue;
        /// <summary>「只有桌面空白可点」的自动到期（见 CaptureTimedOut 的说明）</summary>
        readonly DispatcherTimer _captureTimeout = new DispatcherTimer();
        readonly Border _toast;
        readonly TextBlock _toastText = new TextBlock();

        PayloadDto _payload;
        FrameworkElement _circle;                     // 母泡泡那个圈（在容器里才有）
        string _parentId;                             // 当前在第几层容器（和网页 currentParentId 一个意思）
        int _fetchSeq = 0;                            // 取数据的号：只有最新一次说了算（见 FetchAsync）
        DateTime _lastTick = DateTime.UtcNow;
        string _status = "启动中…";
        IntPtr _hwnd = IntPtr.Zero;
        double _dpiScale = 1.0;
        bool _shotDone = false;                       // --shot 只存一次
        DispatcherTimer _shotTimer = null;
        /// <summary>
        /// 双击判定窗口（毫秒）。**取系统设置**，不是写死的 330。
        ///
        /// ⚠️ 用户报的"双击有时候能进去，有时候无响应"里就有一个纯时序的原因：
        ///    网页那份用的是 330ms（那是给**手指**调的），而 Windows 默认的双击间隔是 500ms。
        ///    用鼠标慢一点双击（350–450ms）就会被判成"两次单击" —— 第一次弹编辑框、
        ///    第二次又被当成第一次……表现就是"时灵时不灵"。
        ///    读 `GetDoubleClickTime()` 就跟着用户自己的系统设置走，不再和手感打架。
        /// </summary>
        readonly double _tapWindowMs = SystemTapWindow();

        static double SystemTapWindow()
        {
            try
            {
                var ms = GetDoubleClickTime();
                if (ms < TAP_WINDOW_MS) ms = (int)TAP_WINDOW_MS;     // 不低于网页那份（触摸要 330）
                if (ms > 900) ms = 900;                              // 别让人把系统调到 2 秒就跟着卡
                return ms;
            }
            catch { return 400; }
        }

        [DllImport("user32.dll")]
        static extern int GetDoubleClickTime();

        // 手势状态（和网页那份一一对应）
        Live _dragging;
        Live _holdBody;
        DateTime _holdStart = DateTime.UtcNow;
        Live _pendingTap;                             // 等"双击窗口"到点再决定是单击还是双击
        string _lastTapKey;
        DateTime _lastTapAt = DateTime.MinValue;
        DateTime _downAt = DateTime.UtcNow;
        Point _downPos;
        bool _bgDown;
        Point _bgDownPos;
        DateTime _bgLastTapAt = DateTime.MinValue;

        Border _tip;

        public BubbleLayer(Options opt)
        {
            _opt = opt;
            _cfg = LayerConfig.Load();
            if (opt.CaptureBackground) _cfg.captureBackground = true;
            // ⚠️ 命令行**显式**给了就以它为准；没给就用"记住的"（托盘菜单里改过的那次）。
            //    第一版写成 `opt.Topmost && _cfg.topmost`，结果是"命令行永远只能关、不能开"。
            if (opt.TopmostGiven) _cfg.topmost = opt.Topmost;
            // 排查用：直接以"已经在某个母泡泡里"启动（正常使用时是双击进去）
            if (!string.IsNullOrEmpty(opt.Parent)) _parentId = opt.Parent;

            // 铺满**整块屏幕**（含任务栏那一条 —— 空白处是点透的，所以不挡任务栏）
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;                 // 背景才可能是"全透明"
            Background = Brushes.Transparent;
            ShowInTaskbar = false;
            ResizeMode = ResizeMode.NoResize;
            Topmost = _cfg.topmost;
            Title = "日程表 · 桌面气泡区";
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = 0; Top = 0;
            Width = SystemParameters.PrimaryScreenWidth;
            Height = SystemParameters.PrimaryScreenHeight;

            Content = _stage;

            // ⚠️⚠️ 「空白处也吃点击」真正要的东西：**一层几乎看不见的膜**。
            //
            //   为什么不是"在 WM_NCHITTEST 里回答 HTCLIENT"就行 ——
            //   实测（`--clickat` + `WindowFromPoint`）：全透明的像素**系统根本不会来问我们**，
            //   它对分层窗口（WPF 的 `AllowsTransparency` = 带 alpha 的 layered window）
            //   是**按像素 alpha 做命中判定**的：alpha = 0 的地方直接穿透给下面的窗口。
            //   所以"点透"其实是系统给的，不是我们答出来的；反过来，想让空白处吃点击，
            //   就必须让那些像素**不透明**（哪怕 alpha = 1，肉眼看不出来）。
            //
            // ⚠️⚠️ 这块膜**只铺"桌面空白"**（用户第 46 轮的明确要求：
            //    "只有桌面空白可点 —— 桌面空白指的是没有图标纯壁纸的地方"）。
            //    所以它是一块**带洞的**形状：工作区 减去
            //      ① 所有可见窗口（含任务栏）—— 有窗口盖着的地方就不算壁纸，
            //         否则用户点浏览器的那一下会被我们抢走；
            //      ② 桌面图标那一块块矩形 —— 点图标要能选中/打开。
            //    洞以外的部分才是 alpha=1（可点）。几何在 `UpdateVeil()` 里算。
            //
            // ⚠️ 任务栏**永远**留在洞外面：托盘图标是这一层唯一的安全出口，
            //    第一版把整屏（含任务栏）都铺上，结果连托盘都点不动 —— 唯一的退路被自己堵死了。
            _veil = new System.Windows.Shapes.Path
            {
                Fill = new SolidColorBrush(Color.FromArgb(1, 0, 0, 0)),   // alpha 1/255 ≈ 看不出来
                Visibility = _cfg.captureBackground ? Visibility.Visible : Visibility.Collapsed,
            };
            _stage.Children.Add(_veil);

            _hud = BuildChip(_hudText, 12.5);
            _hud.Visibility = Visibility.Collapsed;
            _stage.Children.Add(_hud);

            _toast = BuildChip(_toastText, 13);
            _toast.Visibility = Visibility.Collapsed;
            _stage.Children.Add(_toast);

            // ⚠️ 帧率是**量出来的**，别凭感觉调（实测数据见文件头那段）：
            //    加缓存后 20 帧/秒 ≈ 38% 单核、10 帧/秒 ≈ 17%。
            //    泡泡本来只漂 8–18 px/秒，10 帧看着照样是"慢慢飘"，所以取省的那一档。
            _tick.Interval = TimeSpan.FromMilliseconds(100);   // 10 帧/秒
            _tick.Tick += (s, e) => Step();
            _tick.Start();
            _fetch.Interval = TimeSpan.FromSeconds(_opt.IntervalSec);
            _fetch.Tick += (s, e) => FetchAsync();
            _fetch.Start();
            _tapTimer.Interval = TimeSpan.FromMilliseconds(_tapWindowMs);
            _tapTimer.Tick += (s, e) => FirePendingTap();
            // ⚠️ 背景也要等一个"双击窗口"才决定单击还是双击。
            //    第一版**没等**：双击背景的第一下就立刻执行了"加子气泡"（弹网页），
            //    用户报的"双击背景跳转到网页去了，没有退出母泡泡"就是这个。
            _bgTimer.Interval = TimeSpan.FromMilliseconds(_tapWindowMs);
            _bgTimer.Tick += (s, e) => FirePendingBackgroundTap();
            _captureTimeout.Tick += (s, e) => CaptureTimedOut();
            _toastTimer.Interval = TimeSpan.FromSeconds(2.4);
            _toastTimer.Tick += (s, e) => { _toastTimer.Stop(); _toast.Visibility = Visibility.Collapsed; };

            // 手势全部在**窗口**这一层判（见 OnWindowDown 上面那段说明）
            MouseLeftButtonDown += OnWindowDown;
            MouseMove += OnWindowMove;
            MouseLeftButtonUp += OnWindowUp;
            MouseRightButtonUp += (s, e) =>
            {
                var b = PickBubble(e.GetPosition(_stage));
                ShowMenu(b);
                e.Handled = true;
            };

            Loaded += OnLoaded;
        }

        void OnLoaded(object sender, RoutedEventArgs e)
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            RefreshDpi();
            var src = HwndSource.FromHwnd(_hwnd);
            if (src != null) src.AddHook(WndProc);
            // ⚠️ 这里原来有一句"先把整窗设成点透（WS_EX_TRANSPARENT）"。
            //    现在不需要了：点透完全由 `WM_NCHITTEST` 的 `HTTRANSPARENT` 负责，
            //    每次点击前系统都会现问一次（同步、不会差一拍）。
            FetchAsync();
            Log("启动 全屏气泡层 " + (int)Width + "x" + (int)Height + " 置顶=" + Topmost
                + " 空白点透=" + (!_cfg.captureBackground) + " 屏幕缩放=" + _dpiScale.ToString("0.##", CultureInfo.InvariantCulture)
                + " 窗口物理矩形=" + Win32.RectOf(_hwnd));
        }

        /// <summary>
        /// 系统缩放（1.5 = 150%）。**命中判定全靠它** —— 见 HitMath 的说明。
        /// ⚠️ `CompositionTarget.TransformToDevice` 是**实例**属性，不能当静态用
        ///    （第一版这么写，编译报 CS0120）。这里走 VisualTreeHelper.GetDpi，
        ///    拿不到再退回 PresentationSource。
        /// </summary>
        void RefreshDpi()
        {
            try
            {
                var d = VisualTreeHelper.GetDpi(this);
                if (d.DpiScaleX > 0.01) { _dpiScale = d.DpiScaleX; return; }
            }
            catch { /* 往下退 */ }
            try
            {
                var src = PresentationSource.FromVisual(this);
                if (src != null && src.CompositionTarget != null)
                {
                    var m = src.CompositionTarget.TransformToDevice;
                    if (m.M11 > 0.01) _dpiScale = m.M11;
                }
            }
            catch { /* 拿不到就按 1.0 算（宁可偏，也不要因为一个异常把整层弄没） */ }
        }

        static Border BuildChip(TextBlock text, double size)
        {
            text.Foreground = new SolidColorBrush(Color.FromArgb(240, 255, 255, 255));
            text.FontSize = size;
            text.TextWrapping = TextWrapping.Wrap;
            text.MaxWidth = 520;
            return new Border
            {
                Background = new SolidColorBrush(Color.FromArgb(150, 12, 16, 26)),
                BorderBrush = new SolidColorBrush(Color.FromArgb(48, 255, 255, 255)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(11, 7, 11, 7),
                IsHitTestVisible = false,
                Effect = new DropShadowEffect { Color = Colors.Black, BlurRadius = 10, ShadowDepth = 0, Opacity = 0.45 },
                Child = text,
            };
        }

        /// <summary>
        /// 点透：**只用这一个机制** —— 光标不在泡泡/圈上就返回 `HTTRANSPARENT`。
        ///
        /// ⚠️⚠️ 这是**实测**定的（`--clickprobe` 的 A/B 对照，2026-09-25）：
        ///     · 只靠 HTTRANSPARENT → 目标进程的窗口拿到了点击（hit）
        ///     · 再加上 WS_EX_TRANSPARENT 轮询 → 也是 hit（两边都能透）
        ///   既然 HTTRANSPARENT 跨进程也生效，就**只用它**：它是**同步**的
        ///   （系统在每次点击之前现问一次，用的是**此刻**的泡泡位置），
        ///   没有"样式还没关掉"那段空窗。轮询那套是异步的，光标刚移到泡泡上时
        ///   点击会漏给桌面 —— 用户报的"双击有时候能进去，有时候无响应"里就有它一份。
        ///
        ///   ⚠️ 我第一次的实验"证明"HTTRANSPARENT 跨进程不生效，那是**假的**：
        ///      目标窗口被一个开着的浏览器盖住了，点到了浏览器上。
        ///      把目标窗口置顶之后才看出真相。**实验本身错了比没做实验更坏**，
        ///      所以 `--clickprobe` 和这个结论一起留着，随时能复跑。
        /// </summary>
        IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            // 排查用：**Win32 层**到底收到左键没有（绕开 WPF 那套输入管线）。
            // 有这一行就能分清"点击没到窗口"和"到了但 WPF 没交给手势"。
            if (msg == WM_LBUTTONDOWN)
            {
                var v0 = lParam.ToInt64();
                Log("Win32 收到左键按下 @" + (short)(v0 & 0xFFFF) + "," + (short)((v0 >> 16) & 0xFFFF));
            }
            if (msg == WM_NCHITTEST)
            {
                var v = lParam.ToInt64();
                var px = (short)(v & 0xFFFF);
                var py = (short)((v >> 16) & 0xFFFF);
                var dip = HitMath.ToDip(px, py, _dpiScale);
                var interactive = IsInteractive(dip);
                handled = true;
                return new IntPtr(interactive ? HTCLIENT : HTTRANSPARENT);
            }
            return IntPtr.Zero;
        }

        /// <summary>这个 DIP 点上有没有"能点的东西"（泡泡，或者容器那个圈）</summary>
        bool IsInteractive(Point dip)
        {
            // 正在拖 / 按着不放：**一直吃鼠标**，否则拖到空白处会把自己变成点透的
            if (_dragging != null || Mouse.LeftButton == MouseButtonState.Pressed) return true;
            if (_cfg.captureBackground) return true;
            var targets = new List<HitTarget>();
            foreach (var b in _live) targets.Add(new HitTarget { Id = b.Data.id, X = b.X, Y = b.Y, R = b.Radius });
            Point c;
            double r;
            HitTest.CircleGeom(CanvasW(), CanvasH(), out c, out r);
            return HitTest.Classify(dip.X, dip.Y, targets, InContainer(), c, r).Kind != "none";
        }

        double CanvasW() { return Width > 10 ? Width : SystemParameters.PrimaryScreenWidth; }
        double CanvasH() { return Height > 10 ? Height : SystemParameters.PrimaryScreenHeight; }
        bool InContainer() { return _payload != null && _payload.view != null && _payload.view.container != null; }

        // ---------------- 取数据 ----------------
        void FetchAsync()
        {
            // ⚠️⚠️ 每次取数据都领一个号，**回来的号不是最新的就丢掉**。
            //   为什么必须有这个：取数据是异步的（线程池 + WebClient），
            //   而"双击进去一层"也会立刻取一次。如果 60 秒的定时刷新或者上一次
            //   `SendAsync` 之后的刷新**正好在飞**，它的响应会**后到**，
            //   把刚进容器的画面又盖回最外层 —— 用户看到的是
            //   "双击有时候能进去，有时候闪一下又出来了/像没反应"。
            //   号一发，只有最后发出的那次说了算。
            var seq = ++_fetchSeq;
            var parentAtRequest = _parentId;
            var url = _opt.Url + "/api/desktop-bubbles?w=" + (int)CanvasW() + "&h=" + (int)CanvasH()
                + (parentAtRequest != null ? "&parentId=" + Uri.EscapeDataString(parentAtRequest) : "");
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string json;
                try
                {
                    using (var wc = new WebClient())
                    {
                        wc.Encoding = Encoding.UTF8;
                        json = wc.DownloadString(url);
                    }
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() =>
                    {
                        if (seq != _fetchSeq) return;
                        _status = "连不上本地服务";
                        Log("取数据失败：" + ex.Message);
                    });
                    return;
                }
                PayloadDto payload = null;
                try
                {
                    var ser = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
                    payload = ser.Deserialize<PayloadDto>(json);
                }
                catch (Exception ex) { Log("解析失败：" + ex.Message); }
                Dispatcher.Invoke(() =>
                {
                    if (seq != _fetchSeq) { Log("丢掉一次过期的刷新（号 " + seq + " ≠ " + _fetchSeq + "）"); return; }
                    Apply(payload);
                });
            });
        }

        /// <summary>改数据（放进去 / 拉出来 / 戳破）—— 改完立刻重新取一次，界面以服务端为准</summary>
        void SendAsync(string method, string path, string body)
        {
            var url = _opt.Url + path;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    using (var wc = new WebClient())
                    {
                        wc.Encoding = Encoding.UTF8;
                        wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                        wc.UploadString(url, method, body ?? "{}");
                    }
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() => { Toast("改不动：" + ex.Message); Log(method + " " + path + " 失败：" + ex.Message); });
                    return;
                }
                Dispatcher.Invoke(() => FetchAsync());
            });
        }

        void Apply(PayloadDto payload)
        {
            var asked = _parentId;
            _payload = payload;
            var list = (payload != null && payload.bubbles != null) ? payload.bubbles : new List<BubbleDto>();
            _parentId = (payload != null && payload.view != null) ? payload.view.parentId : null;
            _status = "已连接 · " + list.Count + " 颗" + (InContainer() ? " · 在容器里" : "");
            Log("应用视图 请求 parentId=" + (asked ?? "(最外层)") + " 服务端回=" + (_parentId ?? "(最外层)")
                + " " + list.Count + " 颗");

            ApplyCircle();

            var keep = new Dictionary<string, Live>();
            foreach (var b in _live) keep[b.Data.key] = b;
            var next = new List<Live>();
            var added = 0;
            foreach (var dto in list)
            {
                Live b;
                if (keep.TryGetValue(dto.key, out b))
                {
                    // 同一颗还在：**位置不动**（刷新时乱跳最烦人），内容/大小照更新
                    keep.Remove(dto.key);
                    b.Data = dto;
                    b.Radius = Math.Max(14, dto.r);
                    _stage.Children.Remove(b.Root);
                    b.Root = BubbleVisual.Build(dto);
                    b.Ring = BubbleVisual.HoldRing(b.Radius);
                    b.Root.Children.Add(b.Ring);
                    _stage.Children.Add(b.Root);
                    Place(b);
                }
                else
                {
                    b = Create(dto);
                    _stage.Children.Add(b.Root);
                    added += 1;
                }
                next.Add(b);
            }
            foreach (var gone in keep.Values) _stage.Children.Remove(gone.Root);
            _live.Clear();
            _live.AddRange(next);

            ApplyHud();
            if (added > 0 || keep.Count > 0) Log("刷新：" + list.Count + " 颗（+" + added + " / -" + keep.Count + "）"
                + (InContainer() ? " 在「" + _payload.view.container.title + "」里" : ""));
            if (_opt.LogPositions)
            {
                // 排查用：把每颗泡泡的**物理坐标**写出来（`--simdblclick` 要用它当靶子）
                foreach (var b in _live)
                {
                    Log("泡泡 " + b.Data.title + " @" + (int)(b.X * _dpiScale) + "," + (int)(b.Y * _dpiScale)
                        + " r=" + (int)(b.Radius * _dpiScale) + " id=" + b.Data.id);
                }
            }
            MaybeShot();
        }

        /// <summary>
        /// `--shot=<png>`：把**这一层自己渲染出来的**内容存成一张图，然后退出。
        ///
        /// ⚠️ 这不是截屏 —— 它抓的是本窗口的视觉树（RenderTargetBitmap），
        ///    所以用户的桌面、别的软件都不会进到图里。
        ///    用它来验"真壁纸模糊得对不对"这种**只有真机才看得出来**的事
        ///    （渲染自检用的是假壁纸）。
        /// </summary>
        void MaybeShot()
        {
            if (string.IsNullOrEmpty(_opt.Shot)) return;
            if (!_shotDone)
            {
                _shotDone = true;
                // 先按需把编辑框打开（`--edit=<id>` 或 `--edit=new` 新建），这样下面两张图都能拍到
                if (!string.IsNullOrEmpty(_opt.EditId))
                {
                    if (_opt.EditId == "new") OpenNewEditor();
                    else
                    {
                        Live found = null;
                        foreach (var b in _live) if (b.Data.id == _opt.EditId) { found = b; break; }
                        if (found != null) OpenEditor(found);
                        else Log("--edit 没找到这条：" + _opt.EditId);
                    }
                }
            }
            if (_shotTimer != null) return;                 // 已经在等着拍了
            var path = _opt.Shot;
            // 等一拍：让布局/图片解码都落定再画
            _shotTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(800) };
            _shotTimer.Tick += (s, e) =>
            {
                _shotTimer.Stop();
                _shotTimer = null;
                try
                {
                    SaveVisual(_stage, (int)CanvasW(), (int)CanvasH(), path);
                    Log("已把自己的画面存成 " + IOPath.GetFullPath(path));
                    if (EditWindow.Last != null)
                    {
                        var el = EditWindow.Last.Content as FrameworkElement;
                        if (el != null)
                        {
                            el.Measure(new Size(460, double.PositiveInfinity));
                            var h = (int)Math.Ceiling(el.DesiredSize.Height);
                            el.Arrange(new Rect(0, 0, 460, h));
                            var editPath = IOPath.Combine(IOPath.GetDirectoryName(IOPath.GetFullPath(path)),
                                IOPath.GetFileNameWithoutExtension(path) + "-edit.png");
                            SaveVisual(el, 460, Math.Max(120, h), editPath);
                            Log("编辑框也存了一张 " + editPath);
                        }
                    }
                }
                catch (Exception ex) { Log("存画面失败：" + ex.Message); }
                Close();
            };
            _shotTimer.Start();
        }

        static void SaveVisual(FrameworkElement el, int w, int h, string path)
        {
            el.Measure(new Size(w, h));
            el.Arrange(new Rect(0, 0, w, h));
            var bmp = new RenderTargetBitmap(w, h, 96, 96, PixelFormats.Pbgra32);
            bmp.Render(el);
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(bmp));
            var full = IOPath.GetFullPath(path);
            Directory.CreateDirectory(IOPath.GetDirectoryName(full));
            using (var fs = File.Create(full)) enc.Save(fs);
        }

        /// <summary>进/出容器时重建那个圈（一次就好，不必每帧）</summary>
        void ApplyCircle()
        {
            if (_circle != null) { _stage.Children.Remove(_circle); _circle = null; }
            if (!InContainer()) return;
            var c = _payload.view.container;
            if (c == null) return;
            _circle = BubbleVisual.BuildParentCircle(c, CanvasW(), CanvasH());
            _stage.Children.Insert(0, _circle);     // 压在最底下（泡泡在它上面）
            // ⚠️ 这一层**不画桌面**（不读壁纸、不模糊、不贴图）：圈里只有一层淡淡的颜色，
            //    真的桌面从底下透出来。用户第 43 轮的原话就是这么要求的。
            Log("进入容器「" + c.title + "」淡色底=真桌面透出来 过期=" + c.overdue);
        }

        void ApplyHud()
        {
            var hint = (InContainer() && _payload != null && _payload.view != null) ? _payload.view.hint : "";
            if (string.IsNullOrEmpty(hint)) { _hud.Visibility = Visibility.Collapsed; return; }
            // 面包屑 + 提示（和软件里 HUD 那一格一个用法；软件里最外层是空的，这里也一样）
            var crumb = "";
            if (_payload.view.path != null && _payload.view.path.Count > 0)
            {
                var titles = new List<string>();
                foreach (var p in _payload.view.path) titles.Add(p.title);
                crumb = string.Join(" › ", titles.ToArray()) + "\n";
            }
            _hudText.Text = crumb + hint;
            _hud.Visibility = Visibility.Visible;
            _hud.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            Canvas.SetLeft(_hud, 18);
            Canvas.SetTop(_hud, 16);
        }

        Live Create(BubbleDto d)
        {
            var b = new Live { Data = d };
            var r = Math.Max(14, d.r);
            b.Radius = r;
            b.Root = BubbleVisual.Build(d);
            b.Ring = BubbleVisual.HoldRing(r);
            b.Root.Children.Add(b.Ring);
            Scatter(b, 0);
            Place(b);
            return b;
        }

        /// <summary>初始位置：由服务端给的 seed 决定（稳定，不用随机数 —— 重排时加盐）</summary>
        void Scatter(Live b, double salt)
        {
            var s = (b.Data.seed + salt) % 1.0;
            var r = b.Radius;
            var ang = s * Math.PI * 2;
            var sp = 8 + ((s * 5.7) % 1.0) * 10;      // 每秒 8–18 px，慢悠悠地漂
            b.Vx = Math.Cos(ang) * sp;
            b.Vy = Math.Sin(ang) * sp;
            if (InContainer())
            {
                // 在容器里：撒在圈内（别一进来就压在圈边上）
                Point c;
                double cr;
                HitTest.CircleGeom(CanvasW(), CanvasH(), out c, out cr);
                var use = Math.Max(20, cr * 0.72 - r);
                var a = ((s * 7.13) % 1.0) * Math.PI * 2;
                var d = ((s * 3.7) % 1.0) * use;
                b.X = c.X + Math.Cos(a) * d;
                b.Y = c.Y + Math.Sin(a) * d;
            }
            else
            {
                b.X = 40 + s * Math.Max(60, CanvasW() - 2 * r - 80);
                b.Y = 40 + (((s * 7.13) % 1.0)) * Math.Max(60, CanvasH() - 2 * r - 80);
            }
        }

        void Place(Live b)
        {
            // ⚠️ 摆的是**整个画布**（含外晕那圈）的中心 —— 所以用 Root.Width/2，
            //    而不是泡体半径 b.Radius（那个是给命中和漂浮用的）。
            var half = b.Root.Width / 2;
            Canvas.SetLeft(b.Root, b.X - half);
            Canvas.SetTop(b.Root, b.Y - half);
        }

        // ---------------- 每帧：漂浮 + 长按进度 ----------------
        void Step()
        {
            var now = DateTime.UtcNow;
            var dt = Math.Min(0.2, (now - _lastTick).TotalSeconds);
            _lastTick = now;

            // ① 长按进度（2.5 秒戳破）
            if (_holdBody != null && _dragging != null && _dragging == _holdBody)
            {
                var p = (now - _holdStart).TotalMilliseconds / LONG_PRESS_MS;
                BubbleVisual.UpdateHoldRing(_holdBody.Ring, _holdBody.Radius, p);
                if (p >= 1.0) PopBubble(_holdBody);
            }

            // ③ 膜的洞要跟着窗口/图标变（节流在 UpdateVeil 里：窗口 2 秒、图标 10 秒各刷一次）
            UpdateVeil();

            // ④ 漂浮
            foreach (var b in _live)
            {
                if (b.Dragging) continue;
                // 过期 = 定点不动（和网页同一个语义：已经翻篇的事，别再动来动去）
                if (b.Data.overdue) continue;
                var r = b.Radius;
                b.X += b.Vx * dt;
                b.Y += b.Vy * dt;
                if (InContainer())
                {
                    // 圈里：撞到圈壁就弹回来（泡泡不会飘到母泡泡外面去）
                    Point c;
                    double cr;
                    HitTest.CircleGeom(CanvasW(), CanvasH(), out c, out cr);
                    var lim = Math.Max(20, cr - r - 6);
                    var dx = b.X - c.X;
                    var dy = b.Y - c.Y;
                    var d = Math.Sqrt(dx * dx + dy * dy);
                    if (d > lim)
                    {
                        var nx = d > 0.01 ? dx / d : 1;
                        var ny = d > 0.01 ? dy / d : 0;
                        b.X = c.X + nx * lim;
                        b.Y = c.Y + ny * lim;
                        // 反射：把速度沿法线翻过来
                        var dot = b.Vx * nx + b.Vy * ny;
                        b.Vx -= 2 * dot * nx;
                        b.Vy -= 2 * dot * ny;
                    }
                }
                else
                {
                    // ⚠️ 用**泡体**半径（b.Radius），不能用 Root.Width/2 ——
                    //    那个还包含外晕那一圈，泡泡会在离边缘还差 35% 半径的地方就"撞墙"。
                    if (b.X - r < 4) { b.X = 4 + r; b.Vx = Math.Abs(b.Vx); }
                    if (b.X + r > CanvasW() - 4) { b.X = CanvasW() - 4 - r; b.Vx = -Math.Abs(b.Vx); }
                    if (b.Y - r < 4) { b.Y = 4 + r; b.Vy = Math.Abs(b.Vy); }
                    if (b.Y + r > CanvasH() - 4) { b.Y = CanvasH() - 4 - r; b.Vy = -Math.Abs(b.Vy); }
                }
                Place(b);
            }
        }

        // ---------------- 手势：**全部在窗口这一层判** ----------------
        //
        // ⚠️⚠️ 这里为什么不是"给每颗泡泡挂 MouseLeftButtonDown"（那是我第一版的做法）：
        //   泡泡那个 Grid 里的元素**全都设了 `IsHitTestVisible = false`**（外晕/高光/文字都是
        //   装饰，不该各自吃事件），而 Grid 自己又没有 Background ——
        //   于是**整个泡泡在 WPF 的命中测试里几乎没有可点的东西**。
        //   表现正是用户报的"**双击有时候能进去，有时候无响应**"：能不能点到，
        //   取决于 `BitmapCache` 那张缓存图的边界怎么算，等于掷骰子。
        //
        //   改成在窗口这一层用 `PickBubble()` 自己判 —— 它和"点透判定"用的是**同一个函数**，
        //   所以"系统认为这个点该给我们"和"我们认为是哪颗泡泡"永远一致，
        //   不再有两套命中标准打架这种事。
        void OnWindowDown(object sender, MouseButtonEventArgs e)
        {
            var p = e.GetPosition(_stage);
            Log("窗口收到按下 @" + (int)p.X + "," + (int)p.Y);
            _downAt = DateTime.UtcNow;
            _downPos = p;
            _bgDown = false;

            var b = PickBubble(p);
            if (b == null)
            {
                // 背景按下：两种可能（单击 = 加子气泡 / 双击 = 出去），等松手 + 双击窗口才知道
                _bgDown = true;
                _bgDownPos = p;
                return;
            }

            _dragging = b;
            b.Dragging = true;
            b.Grab = new Point(p.X - b.X, p.Y - b.Y);
            _holdBody = b;
            _holdStart = DateTime.UtcNow;
            CaptureMouse();                      // 窗口级捕获：拖出去也不会丢事件
            Log("点下「" + b.Data.title + "」@" + (int)p.X + "," + (int)p.Y);
            e.Handled = true;
        }

        void OnWindowMove(object sender, MouseEventArgs e)
        {
            var p = e.GetPosition(_stage);

            var b = _dragging;
            if (b != null)
            {
                var moved = Math.Abs(p.X - _downPos.X) + Math.Abs(p.Y - _downPos.Y);
                // 移动超过一点就认为"在拖"，取消长按（和网页同一个阈值）
                if (moved > MOVE_SLOP && _holdBody != null)
                {
                    _holdBody = null;
                    BubbleVisual.UpdateHoldRing(b.Ring, b.Radius, 0);
                }
                b.X = Math.Min(CanvasW() - b.Radius - 2, Math.Max(b.Radius + 2, p.X - b.Grab.X));
                b.Y = Math.Min(CanvasH() - b.Radius - 2, Math.Max(b.Radius + 2, p.Y - b.Grab.Y));
                Place(b);
                return;
            }

            if (_bgDown)
            {
                var moved = Math.Sqrt((p.X - _bgDownPos.X) * (p.X - _bgDownPos.X) + (p.Y - _bgDownPos.Y) * (p.Y - _bgDownPos.Y));
                if (moved > MOVE_SLOP) _bgDown = false;
                return;
            }

            // 悬停：光标形状 + 信息卡（都靠同一个 PickBubble）
            var over = PickBubble(p);
            Cursor = over != null ? Cursors.Hand : null;
            if (over != null) ShowTooltip(over, p);
            else if (_tip != null) _tip.Visibility = Visibility.Collapsed;
        }

        void OnWindowUp(object sender, MouseButtonEventArgs e)
        {
            var p = e.GetPosition(_stage);

            // ---- 点在背景上：单击 = 加子气泡，双击 = 出去 ----
            //
            // ⚠️ 和网页同一条判据：背景上**只有位移**有意义（背景没有"长按"这个手势），
            //    所以不设"按住的时长"门槛 —— 网页那边就是因为 400ms 的时长闸门，
            //    在 iPad 上变成了"单击背景一点反应都没有"。
            if (_dragging == null)
            {
                if (!_bgDown) return;
                _bgDown = false;
                var movedBg = Math.Sqrt((p.X - _bgDownPos.X) * (p.X - _bgDownPos.X) + (p.Y - _bgDownPos.Y) * (p.Y - _bgDownPos.Y));
                if (movedBg >= MOVE_SLOP) return;
                var nowB = DateTime.UtcNow;
                if ((nowB - _bgLastTapAt).TotalMilliseconds < _tapWindowMs)
                {
                    // 第二下 = 双击背景 → 取消"单击"那一支，出去一层
                    _bgLastTapAt = DateTime.MinValue;
                    _bgTimer.Stop();
                    Log("双击背景 → 出去一层" + (InContainer() ? "" : "（已经在最外层，忽略）"));
                    if (InContainer()) ExitOneLevel();
                    return;
                }
                _bgLastTapAt = nowB;
                Log("背景第一下：等双击窗口（" + (int)_tapWindowMs + "ms）看是不是双击");
                // ⚠️ 第一下**不能马上执行**：得等一个双击窗口，否则双击的第一下就已经
                //    "加子气泡"了（用户报的就是这个：双击背景跳转到网页去了，没退出去）。
                _bgTimer.Stop();
                _bgTimer.Start();
                return;
            }

            var b = _dragging;
            var moved = Math.Abs(p.X - _downPos.X) + Math.Abs(p.Y - _downPos.Y);
            var ms = (DateTime.UtcNow - _downAt).TotalMilliseconds;
            b.Dragging = false;
            try { ReleaseMouseCapture(); } catch { /* ignore */ }
            if (_holdBody != null) { BubbleVisual.UpdateHoldRing(b.Ring, b.Radius, 0); _holdBody = null; }
            _dragging = null;
            e.Handled = true;

            // 轻点 = 几乎没动 + 没按到"快成长按"（和网页同一条判据）
            var quick = moved < MOVE_SLOP && ms < LONG_PRESS_MS * 0.5;
            // 把判断依据写进日志：排查"点不动/双击不灵"时不用猜
            Log("松开「" + b.Data.title + "」位移=" + (int)moved + " 按住=" + (int)ms + "ms 算轻点=" + quick);
            if (!quick) { ResolveDrop(b); return; }

            var now = DateTime.UtcNow;
            var sinceLast = _lastTapAt == DateTime.MinValue ? 999999.0 : (now - _lastTapAt).TotalMilliseconds;
            if (_lastTapKey == b.Data.key && sinceLast < _tapWindowMs)
            {
                // 双击 = 进去
                _tapTimer.Stop();
                _pendingTap = null;
                _lastTapKey = null;
                Log("双击（距上次单击 " + (int)sinceLast + "ms < 窗口 " + (int)_tapWindowMs + "ms）→ 进去");
                EnterBubble(b);
                return;
            }
            Log("记一次单击（距上次 " + (int)sinceLast + "ms，窗口 " + (int)_tapWindowMs + "ms）");
            _lastTapKey = b.Data.key;
            _lastTapAt = now;
            _pendingTap = b;
            _tapTimer.Stop();
            _tapTimer.Start();     // 等一个双击窗口：到点还没等到第二下 = 单击（编辑）
        }

        /// <summary>
        /// 这个 DIP 点上**是哪颗泡泡**（没有就 null）。从后往前找 = 后画的在上面。
        ///
        /// ⚠️ 这是**唯一**的泡泡命中判定：点透（`IsInteractive`）、按下、悬停、拖放目标
        ///    全都走它。两套判定各判各的，就会出现"系统把点击给了我们、
        ///    我们却认为没点在任何泡泡上"这种自相矛盾。
        /// </summary>
        Live PickBubble(Point dip)
        {
            for (var i = _live.Count - 1; i >= 0; i -= 1)
            {
                var b = _live[i];
                var dx = dip.X - b.X;
                var dy = dip.Y - b.Y;
                var r = Math.Max(14, b.Radius);
                if (dx * dx + dy * dy <= r * r) return b;
            }
            return null;
        }

        void FirePendingTap()
        {
            _tapTimer.Stop();
            var b = _pendingTap;
            _pendingTap = null;
            _lastTapKey = null;
            if (b == null) return;
            OpenEditor(b);                       // 单击 = 编辑（弹**编辑框**，不开浏览器）
        }

        /// <summary>
        /// 打开编辑框之前先把上一个关掉 —— **同时只留一个**。
        /// ⚠️ 不这么做的话，点几个泡泡就会叠出一摞卡片：它们都是置顶窗口，
        ///    互相盖住之后看起来就是"关不掉的一堆编辑区"（用户报的现象之一）。
        /// </summary>
        void CloseAnyEditor()
        {
            var prev = EditWindow.Last;
            if (prev == null) return;
            try { prev.Close(); } catch { /* 已经关了就忽略 */ }
        }

        /// <summary>单击泡泡 → 弹编辑框（这个窗口里只改常用几项，完整编辑器留了出口）</summary>
        void OpenEditor(Live b)
        {
            Log("打开编辑框「" + b.Data.title + "」");
            CloseAnyEditor();
            var w = new EditWindow(_opt, this, b.Data, null, _payload != null ? _payload.levels : null);
            // Owner = 这一层：层关掉时编辑框跟着关，z 序也永远在它上面
            w.Owner = this;
            w.Show();
            w.Activate();
        }

        /// <summary>容器里单击背景 → 弹编辑框新建一个子气泡（等级只能选 core 允许的那几档）</summary>
        void OpenChildEditor()
        {
            var c = (_payload != null && _payload.view != null) ? _payload.view.container : null;
            if (c == null) return;
            if (c.readOnly) { Toast("这个紫泡泡过期了，只能看看"); return; }
            Log("打开编辑框（新建子气泡，父=「" + c.title + "」）");
            CloseAnyEditor();
            var w = new EditWindow(_opt, this, null, c, _payload.levels);
            w.Owner = this;
            w.Show();
            w.Activate();
        }

        /// <summary>
        /// **最外层**单击空白 → 弹编辑框新建一条日程。
        ///
        /// ⚠️ 这条只在"空白处也吃点击"打开时才可能触发（关着的时候空白处的点击
        ///    根本不会到我们这儿，是**点透**给桌面的 —— 见 `IsInteractive`）。
        ///    和网页气泡区同一个语义：最外层单击背景 = 新建一条。
        /// </summary>
        void OpenNewEditor()
        {
            Log("打开编辑框（新建日程，最外层）");
            CloseAnyEditor();
            var w = new EditWindow(_opt, this, null, null, _payload != null ? _payload.levels : null);
            w.Owner = this;
            w.Show();
            w.Activate();
        }

        /// <summary>编辑框改完东西之后：刷新这一层（数据以服务端为准）</summary>
        public void OnEdited(string msg)
        {
            if (!string.IsNullOrEmpty(msg)) Toast(msg);
            FetchAsync();
        }

        /// <summary>双击泡泡 = 进到它里面（蓝色最小档进不去，抖一下 + 说明原因）</summary>
        void EnterBubble(Live b)
        {
            var msg = _payload != null ? _payload.messages : null;
            if (b.Data.canHold != true)
            {
                Shake(b);
                if (msg != null) Toast(msg.cannotEnterLeaf + " —— " + msg.cannotEnterLeafBody);
                return;
            }
            _parentId = b.Data.id;
            FetchAsync();
        }

        /// <summary>
        /// 松手时的"归属判定"（和网页 resolveDrop 同一套规则）：
        ///   · 在容器里、松手落在**圈外** → 拉出来，和母泡泡平级
        ///   · 压着另一颗泡泡 → 试着放进去（能不能进由 core 给的 childLevels 决定）
        /// 真正的写入交给服务端（PATCH /api/events/&lt;id&gt;），原生只说"用户想怎么放"。
        /// </summary>
        void ResolveDrop(Live b)
        {
            var msg = _payload != null ? _payload.messages : null;

            if (InContainer())
            {
                Point c;
                double cr;
                HitTest.CircleGeom(CanvasW(), CanvasH(), out c, out cr);
                var dx = b.X - c.X;
                var dy = b.Y - c.Y;
                // 1.05 倍的余量：贴着圈边松手不算"出去"（和网页 OUT_MARGIN 同一个数）
                if (Math.Sqrt(dx * dx + dy * dy) > cr * 1.05)
                {
                    var escapeTo = _payload.view.container.escapeTo;
                    Toast(msg != null ? msg.escaped : "已拉出来");
                    SendAsync("PATCH", "/api/events/" + Uri.EscapeDataString(b.Data.id),
                        "{\"parentId\":" + (escapeTo == null ? "null" : "\"" + escapeTo + "\"") + "}");
                    return;
                }
            }

            var target = BestDropTarget(b);
            if (target == null) return;
            if (target.Data.id == b.Data.id) return;

            // 过期（紫）的既不进别人，也不装别人（和网页同一句提示）
            if (b.Data.overdue || target.Data.overdue)
            {
                Shake(target);
                Toast(msg != null ? msg.cannotNestOverdue : "紫色气泡不能套");
                return;
            }
            // 能不能进：core 已经把它能装的等级算好放在 childLevels 里（这里不重写"红>黄>绿>蓝"）
            var ok = target.Data.childLevels != null && target.Data.childLevels.Contains(b.Data.levelKey);
            if (!ok)
            {
                Shake(target);
                Toast(msg != null ? msg.cannotNest : "放不进去");
                return;
            }
            Toast(msg != null ? (msg.nested + "：「" + b.Data.title + "」→「" + target.Data.title + "」") : "已放进气泡");
            SendAsync("PATCH", "/api/events/" + Uri.EscapeDataString(b.Data.id),
                "{\"parentId\":\"" + target.Data.id + "\"}");
        }

        /// <summary>被拖的泡泡"压住"了谁：优先"圆心在对方圆内"，其次重叠够多（和网页同一套）</summary>
        Live BestDropTarget(Live b)
        {
            Live byCenter = null;
            Live byOverlap = null;
            var bestOverlap = 0.0;
            foreach (var o in _live)
            {
                if (o == b || o.Dragging) continue;
                var d = Math.Sqrt((b.X - o.X) * (b.X - o.X) + (b.Y - o.Y) * (b.Y - o.Y));
                if (d <= o.Radius)
                {
                    if (byCenter == null || o.Radius > byCenter.Radius) byCenter = o;
                }
                var overlap = b.Radius + o.Radius - d;
                if (overlap > 0 && overlap > bestOverlap) { bestOverlap = overlap; byOverlap = o; }
            }
            if (byCenter != null) return byCenter;
            if (byOverlap != null && bestOverlap >= Math.Min(b.Radius, byOverlap.Radius) * 0.5) return byOverlap;
            return null;
        }

        /// <summary>长按 2.5 秒 = 戳破（**按实例记账**：把这一颗的日期和当时剩余时间一起回传）</summary>
        void PopBubble(Live b)
        {
            _holdBody = null;
            BubbleVisual.UpdateHoldRing(b.Ring, b.Radius, 0);
            _dragging = null;
            b.Dragging = false;
            try { b.Root.ReleaseMouseCapture(); } catch { /* ignore */ }
            var msg = _payload != null ? _payload.messages : null;
            Toast(msg != null ? msg.pop : "戳破了");
            var body = new Dictionary<string, object>();
            if (!string.IsNullOrEmpty(b.Data.occurrence)) body["occurrence"] = b.Data.occurrence;
            if (b.Data.remainingMs.HasValue) body["remainingMs"] = b.Data.remainingMs.Value;
            var json = new JavaScriptSerializer().Serialize(body);
            Log("戳破「" + b.Data.title + "」" + json);
            SendAsync("POST", "/api/events/" + Uri.EscapeDataString(b.Data.id) + "/pop", json);
        }

        /// <summary>背景被单击（等过了双击窗口才算数）：在容器里 = 加子气泡</summary>
        void FirePendingBackgroundTap()
        {
            _bgTimer.Stop();
            _bgLastTapAt = DateTime.MinValue;
            if (InContainer()) { Log("背景单击（过了双击窗口）→ 加子气泡"); OpenChildEditor(); return; }
            // ⚠️ 最外层单击空白 = **新建一条**（和网页气泡区一致）。
            //    用户就是这么用的：打开"空白处也吃点击"然后在桌面空地上点一下，期望弹出新建。
            //    我第一版这里只写了"什么都不做"，所以他点了没反应。
            Log("背景单击（过了双击窗口）→ 新建日程");
            OpenNewEditor();
        }

        void ExitOneLevel()
        {
            var to = _payload.view.container.escapeTo;
            _parentId = to;
            FetchAsync();
        }

        // ---------------- 提示 / 抖动 / 悬停说明 ----------------
        void Toast(string text)
        {
            _toastText.Text = text;
            _toast.Visibility = Visibility.Visible;
            _toast.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            Canvas.SetLeft(_toast, Math.Max(8, CanvasW() / 2 - _toast.DesiredSize.Width / 2));
            Canvas.SetTop(_toast, CanvasH() - _toast.DesiredSize.Height - 48);
            _toastTimer.Stop();
            _toastTimer.Start();
        }

        /// <summary>拒绝时"抖一下"（和被拒绝的那个泡泡说话，和网页 target.shake 一样）</summary>
        void Shake(Live b)
        {
            var t = b.Root.RenderTransform as TranslateTransform;
            if (t == null) { t = new TranslateTransform(0, 0); b.Root.RenderTransform = t; }
            var a = new System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames();
            var frames = new[] { 0.0, -7.0, 7.0, -5.0, 5.0, 0.0 };
            for (var i = 0; i < frames.Length; i += 1)
            {
                a.KeyFrames.Add(new System.Windows.Media.Animation.LinearDoubleKeyFrame(
                    frames[i], System.Windows.Media.Animation.KeyTime.FromTimeSpan(TimeSpan.FromMilliseconds(i * 55))));
            }
            t.BeginAnimation(TranslateTransform.XProperty, a);
        }

        Border Tooltip()
        {
            if (_tip == null)
            {
                _tip = BuildChip(new TextBlock
                {
                    Foreground = Brushes.White, FontSize = 12.5,
                    TextWrapping = TextWrapping.Wrap, MaxWidth = 300,
                }, 12.5);
                _tip.Visibility = Visibility.Collapsed;
                _stage.Children.Add(_tip);
            }
            return _tip;
        }

        void ShowTooltip(Live b, Point at)
        {
            var d = b.Data;
            var tip = Tooltip();
            ((TextBlock)tip.Child).Text = d.title + "\n" + d.when + "　" + d.countdown
                + (string.IsNullOrEmpty(d.location) ? "" : "\n📍 " + d.location)
                + (d.canHold ? "\n双击进去 · 长按 2.5 秒戳破" : "\n长按 2.5 秒戳破");
            tip.Visibility = Visibility.Visible;
            tip.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            Canvas.SetLeft(tip, Math.Max(8, Math.Min(CanvasW() - tip.DesiredSize.Width - 8, at.X + 16)));
            Canvas.SetTop(tip, Math.Max(8, Math.Min(CanvasH() - tip.DesiredSize.Height - 8, at.Y + 16)));
        }

        // ---------------- 右键菜单 ----------------
        void ShowMenu(Live on)
        {
            var menu = new ContextMenu();
            if (on != null)
            {
                var captured = on;
                menu.Items.Add(Item("编辑「" + Trim(captured.Data.title, 14) + "」", () => OpenEditor(captured)));
                if (captured.Data.canHold) menu.Items.Add(Item("进到它里面（套娃）", () => EnterBubble(captured)));
                menu.Items.Add(Item("在浏览器里打开（完整编辑器）",
                    () => Open(_opt.Url + "/index.html?open=" + Uri.EscapeDataString(captured.Data.id))));
                menu.Items.Add(new Separator());
            }
            if (InContainer())
            {
                menu.Items.Add(Item("回到最外层", () => { _parentId = null; FetchAsync(); }));
                menu.Items.Add(Item("往「" + Trim(_payload.view.container.title, 12) + "」里加一个", OpenChildEditor));
                menu.Items.Add(new Separator());
            }
            menu.Items.Add(Item((Topmost ? "✓ " : "　") + "浮在所有窗口之上", () => SetTopmost(!Topmost)));
            menu.Items.Add(Item((_cfg.captureBackground ? "✓ " : "　") + "空白处也吃点击（关掉 = 点透桌面）", ToggleCapture));
            menu.Items.Add(new Separator());
            menu.Items.Add(Item("立即刷新", () => FetchAsync()));
            menu.Items.Add(Item("重排位置", Reshuffle));
            menu.Items.Add(new Separator());
            menu.Items.Add(Item("打开日程表", OpenApp));
            menu.Items.Add(Item("状态：" + _status, null));
            menu.Items.Add(new Separator());
            menu.Items.Add(Item("退出桌面气泡区", Close));
            menu.IsOpen = true;
        }

        void Open(string url)
        {
            try { System.Diagnostics.Process.Start(url); }
            catch (Exception ex) { Log("打开失败：" + ex.Message); }
        }

        void Reshuffle()
        {
            var salt = DateTime.Now.Millisecond / 1000.0;
            foreach (var b in _live) { Scatter(b, salt); Place(b); }
            Log("重排完成");
        }

        /// <summary>
        /// 置顶开关。
        /// ⚠️ 这一层是"浮在所有窗口之上、但空白处点透"的：
        ///   · 置顶（默认）→ 一直看得见；不想让它压住别的软件就关掉（只在看桌面时看到）
        /// </summary>
        void SetTopmost(bool on)
        {
            Topmost = on;
            _cfg.topmost = on;
            _cfg.Save();
            _status = on ? "置顶" : "只在桌面";
            Log("置顶 = " + on);
        }

        /// <summary>
        /// "空白处也吃点击"开关（默认关）。
        /// ⚠️ 默认必须是**关**的：这一层压在整个桌面上，空白处要是也吃点击，
        ///    桌面就点不动了。打开它的意义是"整屏都算气泡区"。
        /// </summary>
        void ToggleCapture()
        {
            _cfg.captureBackground = !_cfg.captureBackground;
            _cfg.Save();
            // 那层膜才是"桌面空白处吃不吃点击"的开关（alpha=0 的像素系统直接穿透，问都不问我们）
            if (_veil != null) _veil.Visibility = _cfg.captureBackground ? Visibility.Visible : Visibility.Collapsed;
            if (_cfg.captureBackground) { UpdateVeil(true); StartCaptureTimeout(); }
            else _captureTimeout.Stop();
            _status = _cfg.captureBackground ? "只有桌面空白可点" : "空白处点透";
            Log("桌面空白可点 = " + _cfg.captureBackground
                + "（膜" + (_cfg.captureBackground ? "已铺上" : "已撤掉") + "）");
        }

        /// <summary>
        /// 重算那层膜的形状：**工作区 减去 可见窗口 减去 桌面图标**。
        ///
        /// 几何用 `GeometryGroup` + `FillRule = EvenOdd`：外圈是工作区，
        /// 每加一个矩形就"挖掉"一块（偶奇规则：被覆盖偶数次的地方不填充）。
        ///
        /// ⚠️ 图标位置来自 UI Automation（慢），所以：
        ///   · 图标每 10 秒在**后台线程**刷一次（`_iconScanBusy` 防重入）；
        ///   · 窗口矩形每 2 秒刷一次（`EnumWindows` 很快，可以在 UI 线程上做）；
        ///   · 从"没开"切到"开"时立刻算一次（`force`）。
        /// </summary>
        /// <summary>
        /// 「只有桌面空白可点」**最多活 3 分钟**，到点自己关。
        ///
        /// ⚠️ 为什么必须有：那个模式天生会和"**突然弹出来的窗口**"抢一次点击 ——
        ///    它的窗口清单 2 秒才刷一次（图标 10 秒），而权限弹窗 / UAC 是突然出现的，
        ///    那 2 秒里点它就会被我们吃掉。我第一版忘了关掉它，用户点不到权限确认，
        ///    是他自己告诉我的（"你这样调试我会点不到你的权限按钮"）。
        ///    有个上限就永远不会发生第二次 —— 不靠"我记得关"。
        /// </summary>
        void StartCaptureTimeout()
        {
            _captureTimeout.Stop();
            _captureTimeout.Interval = TimeSpan.FromMinutes(3);
            _captureTimeout.Start();
            Log("「桌面空白可点」3 分钟后会自动关掉（防止挡住你点弹窗）");
        }

        void CaptureTimedOut()
        {
            _captureTimeout.Stop();
            if (!_cfg.captureBackground) return;
            ToggleCapture();      // 关掉它（会写配置 + 撤膜 + 记日志）
            Toast("「桌面空白可点」开了 3 分钟，已经自动关掉了 —— 免得它挡住你点弹窗");
            Log("「桌面空白可点」3 分钟到，已自动关闭");
        }

        void UpdateVeil(bool force = false)
        {
            if (_veil == null || !_cfg.captureBackground) return;
            var now = DateTime.UtcNow;
            if (!force && (now - _lastVeilBuild).TotalMilliseconds < 2000) return;
            _lastVeilBuild = now;

            // 图标：后台读（UIA 可能几百毫秒，卡在 UI 线程上整层就顿了）
            if (!_iconScanBusy && (now - _lastIconScan).TotalSeconds > 10)
            {
                _iconScanBusy = true;
                _lastIconScan = now;
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    List<int[]> rects = null;
                    string err = null;
                    try { rects = DesktopIcons.Rects(); err = DesktopIcons.LastError; }
                    catch (Exception ex) { err = ex.Message; }
                    Dispatcher.Invoke(() =>
                    {
                        _iconScanBusy = false;
                        if (rects != null)
                        {
                            _iconRects = rects;
                            // 日志里留一份（--logpositions 排查"某个点到底算不算空白"时要用）
                            if (_opt.LogPositions)
                            {
                                Log("桌面图标 " + _iconRects.Count + " 个"
                                    + (err != null ? "（读取警告：" + err + "）" : ""));
                                for (var i = 0; i < _iconRects.Count; i += 1)
                                {
                                    var nm = i < DesktopIcons.Names.Count ? DesktopIcons.Names[i] : "";
                                    Log("  图标区 " + _iconRects[i][0] + "," + _iconRects[i][1]
                                        + " - " + _iconRects[i][2] + "," + _iconRects[i][3]
                                        + "  " + nm);
                                }
                            }
                        }
                    });
                });
            }

            var s = _dpiScale > 0.01 ? _dpiScale : 1.0;
            var wa = SystemParameters.WorkArea;                  // DIP
            var geo = new GeometryGroup { FillRule = FillRule.EvenOdd };
            geo.Children.Add(new RectangleGeometry(new Rect(wa.Left, wa.Top, wa.Width, wa.Height)));

            var blocked = Win32.BlockingWindowRects(_hwnd);
            foreach (var r in blocked)
            {
                var rect = PhysToDipRect(r, s);
                if (rect.Width < 2 || rect.Height < 2) continue;
                geo.Children.Add(new RectangleGeometry(rect));
            }
            // 图标：往外扩 4 DIP（图标周围那点空隙也算"图标区"，免得贴边点被抢）
            foreach (var r in _iconRects)
            {
                var rect = PhysToDipRect(r, s);
                rect.Inflate(4, 4);
                geo.Children.Add(new RectangleGeometry(rect));
            }

            _veil.Data = geo;
            if (_opt.LogPositions)
            {
                // 实心面积占比：一眼看出"膜还剩多少可点"。
                // Chrome 最大化铺满时它会接近 0（那是对的 —— 壁纸没露出来就没得点）
                var whole = Math.Max(1.0, wa.Width * wa.Height);
                var solid = 0.0;
                try { solid = geo.GetArea(); } catch { /* 算不出来就算了 */ }
                Log("膜的洞：可见窗口 " + blocked.Count + " 个 · 图标 " + _iconRects.Count
                    + " 个 · 可点面积 ≈ " + Math.Round(100 * solid / whole) + "%");
                foreach (var r in blocked)
                {
                    Log("  窗口区 " + r[0] + "," + r[1] + " - " + r[2] + "," + r[3]);
                }
            }
        }

        /// <summary>物理像素矩形 → DIP 矩形</summary>
        static Rect PhysToDipRect(int[] r, double scale)
        {
            return new Rect(r[0] / scale, r[1] / scale, (r[2] - r[0]) / scale, (r[3] - r[1]) / scale);
        }

        // ---- 给托盘菜单调的（同一线程，直接调）----
        public void OpenApp() { Open(_opt.Url); }
        public void MenuRefresh() { FetchAsync(); }
        public void MenuReshuffle() { Reshuffle(); }
        public void MenuQuit() { Close(); }
        public void MenuToggleTopmost() { SetTopmost(!Topmost); }
        public void MenuToggleCapture() { ToggleCapture(); }
        public void MenuRoot() { _parentId = null; FetchAsync(); }
        /// <summary>托盘菜单画勾用</summary>
        public bool IsTopmost() { return Topmost; }
        public bool IsCapturing() { return _cfg.captureBackground; }

        static MenuItem Item(string text, Action onClick)
        {
            var mi = new MenuItem { Header = text };
            if (onClick != null) mi.Click += (s, e) => onClick();
            return mi;
        }

        static string Trim(string s, int n)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length <= n ? s : s.Substring(0, n) + "…";
        }

        public static void Log(string msg)
        {
            try
            {
                // 日志落在仓库的 build/ 下（build/ 不进版本库）：排查时直接看这个文件
                var dir = IOPath.GetFullPath(IOPath.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "build"));
                Directory.CreateDirectory(dir);
                File.AppendAllText(IOPath.Combine(dir, "desktop-bubbles.log"),
                    DateTime.Now.ToString("HH:mm:ss") + "  " + msg + Environment.NewLine, Encoding.UTF8);
            }
            catch { /* 日志写不了不影响使用 */ }
        }
    }

    // -------------------------------------------------------------------------
    // 排查工具：验"点透"到底有没有把点击放给**别的进程**的窗口
    //
    // ⚠️ 为什么要专门验：`WM_NCHITTEST` 返回 `HTTRANSPARENT` 的"点透"，
    //    文档只承诺"消息会继续给**同一个线程**里下面的窗口"，
    //    跨进程行不行在各 Windows 版本上并不一致。而这一层压在整个桌面上，
    //    一旦点不透，用户会觉得"桌面点不动了"—— 所以我不敢只靠文档，
    //    宁可开一个**别的进程的小窗口**在下面，真的点一下看它收不收得到。
    //
    // 用法（两个进程，顺序不能反）：
    //   1) 先起气泡层：`DesktopBubbles.exe --url=… --no-clickpoll`
    //   2) 再起这个目标窗口：`DesktopBubbles.exe --clickprobe=out.txt`
    //      它 1.5 秒后把光标挪到自己身上点一下，4 秒后把 hit/miss 写进 out.txt
    // -------------------------------------------------------------------------
    static class ClickProbe
    {
        [DllImport("user32.dll")]
        static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")]
        static extern int GetSystemMetrics(int index);
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT
        {
            public uint type;
            public MOUSEINPUT mi;
        }
        const uint INPUT_MOUSE = 0;
        const uint MOVE = 0x0001;
        const uint ABSOLUTE = 0x8000;

        /// <summary>
        /// 把光标挪到物理坐标 (x,y) 并点一下。
        ///
        /// ⚠️⚠️ 这里**必须**用 `SendInput` 的"绝对移动"，不能用 `SetCursorPos`：
        ///    实测（见 `--clickprobe` 的输出）`SetCursorPos` 从这个进程里调用**静默失败** ——
        ///    光标还在原处（日志里 `cursor=2253,1440`），于是"点一下"点到了别的地方，
        ///    整个实验全是假阴性。`SendInput` 把移动和按键放在同一条输入事件里，可靠得多。
        /// </summary>
        static bool MoveAndClick(int x, int y)
        {
            var sw = Math.Max(1, GetSystemMetrics(0) - 1);      // SM_CXSCREEN
            var sh = Math.Max(1, GetSystemMetrics(1) - 1);      // SM_CYSCREEN
            var nx = (int)(x * 65535L / sw);
            var ny = (int)(y * 65535L / sh);
            var seq = new INPUT[3];
            seq[0].type = INPUT_MOUSE;
            seq[0].mi.dwFlags = MOVE | ABSOLUTE;
            seq[0].mi.dx = nx;
            seq[0].mi.dy = ny;
            seq[1].type = INPUT_MOUSE;
            seq[1].mi.dwFlags = LEFTDOWN;
            seq[2].type = INPUT_MOUSE;
            seq[2].mi.dwFlags = LEFTUP;
            var sent = SendInput(3, seq, Marshal.SizeOf(typeof(INPUT)));
            return sent == 3;
        }

        /// <summary>只挪光标（移动和按键分开：双击要两次按下抬起）</summary>
        static bool MoveTo(int x, int y)
        {
            var sw = Math.Max(1, GetSystemMetrics(0) - 1);
            var sh = Math.Max(1, GetSystemMetrics(1) - 1);
            var seq = new INPUT[1];
            seq[0].type = INPUT_MOUSE;
            seq[0].mi.dwFlags = MOVE | ABSOLUTE;
            seq[0].mi.dx = (int)(x * 65535L / sw);
            seq[0].mi.dy = (int)(y * 65535L / sh);
            return SendInput(1, seq, Marshal.SizeOf(typeof(INPUT))) == 1;
        }

        static bool ClickOnce()
        {
            // ⚠️ 用**老的 `mouse_event`** 而不是 `SendInput`：
            //    SendInput 的按键在"跨进程"时会被系统悄悄丢掉（返回真、但窗口收不到
            //    WM_LBUTTONDOWN —— 实测日志里就是这样），而 mouse_event 是另一条路。
            //    排查工具本身不可靠的话，会把我引到"功能是坏的"这种错结论上。
            try
            {
                mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
                Thread.Sleep(20);
                mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
                return true;
            }
            catch { return false; }
        }

        [DllImport("user32.dll")]
        static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
        [DllImport("user32.dll")]
        static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")]
        static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")]
        static extern int GetClassName(IntPtr hWnd, StringBuilder buf, int max);
        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out POINT p);
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }
        const uint LEFTDOWN = 0x0002;
        const uint LEFTUP = 0x0004;

        static string ClassOf(IntPtr h)
        {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        /// <summary>
        /// `--clickat=x,y[,次数[,间隔ms]]`：在物理坐标上合成 1 次或多次左键点击。
        ///
        /// ⚠️⚠️ 它为什么要**开一个 1×1 的透明顶层窗口**：
        ///    注入的点击在**调用进程不是前台进程**时会被系统悄悄丢掉
        ///    （API 返回成功、但目标窗口收不到 `WM_LBUTTONDOWN` —— 日志里就是这样）。
        ///    没有窗口的进程永远当不了前台，所以 `--simdblclick` 时灵时不灵，
        ///    害我以为"双击是坏的"（**排查工具本身不可靠最坑**）。
        ///    有一个（藏在屏幕外的）窗口再 `Activate()` 一下，注入就稳定了。
        /// </summary>
        public static void ClickAt(string spec)
        {
            var parts = (spec ?? "").Split(',');
            if (parts.Length < 2) return;
            var x = int.Parse(parts[0].Trim(), CultureInfo.InvariantCulture);
            var y = int.Parse(parts[1].Trim(), CultureInfo.InvariantCulture);
            var count = parts.Length > 2 ? Math.Max(1, int.Parse(parts[2].Trim(), CultureInfo.InvariantCulture)) : 1;
            var gap = parts.Length > 3 ? int.Parse(parts[3].Trim(), CultureInfo.InvariantCulture) : 220;

            var w = new Window
            {
                Width = 1,
                Height = 1,
                Left = -20,                     // 藏到屏幕外，别挡着要看的东西
                Top = -20,
                WindowStyle = WindowStyle.None,
                AllowsTransparency = true,
                Background = Brushes.Transparent,
                Topmost = true,
                ShowInTaskbar = false,
                Title = "点击注入用的小窗口",
            };
            var t = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1200) };
            t.Tick += (s, e) =>
            {
                t.Stop();
                try
                {
                    w.Activate();
                    Thread.Sleep(150);
                    MoveTo(x, y);
                    BubbleLayer.Log("clickat 移动 " + x + "," + y + At(x, y));
                    Thread.Sleep(300);          // 让光标/悬停稳定下来（有些逻辑靠鼠标位置）
                    for (var i = 0; i < count; i += 1)
                    {
                        ClickOnce();
                        BubbleLayer.Log("clickat 第 " + (i + 1) + " 下 " + At(x, y));
                        if (i < count - 1) Thread.Sleep(gap);
                    }
                    Thread.Sleep(900);          // 等目标把事件处理完
                }
                catch (Exception ex) { BubbleLayer.Log("clickat 出错：" + ex.Message); }
                w.Close();
            };
            t.Start();
            new Application().Run(w);
        }

        /// <summary>
        /// `--simdblclick=x,y[,间隔ms]`：在物理坐标 (x,y) 上合成一次双击。
        /// 用来端到端验"双击泡泡能不能稳定进去"——把光标挪过去、点两下、退出，
        /// 然后看气泡层的日志里有没有"进入容器"。
        /// </summary>
        public static void SimDblClick(string spec)
        {
            var parts = (spec ?? "").Split(',');
            if (parts.Length < 2) return;
            var x = int.Parse(parts[0].Trim(), CultureInfo.InvariantCulture);
            var y = int.Parse(parts[1].Trim(), CultureInfo.InvariantCulture);
            var gap = parts.Length > 2 ? int.Parse(parts[2].Trim(), CultureInfo.InvariantCulture) : 220;
            var moved = MoveTo(x, y);
            BubbleLayer.Log("simdblclick 移动到 " + x + "," + y + " → " + moved + At(x, y));
            Thread.Sleep(400);                  // 等系统把光标挪过去
            var c1 = ClickOnce();
            BubbleLayer.Log("simdblclick 第 1 下 → " + c1 + At(x, y));
            Thread.Sleep(gap);
            var c2 = ClickOnce();
            BubbleLayer.Log("simdblclick 第 2 下 → " + c2 + At(x, y));
            // ⚠️ **别马上退出**：合成输入是交给系统输入队列的，
            //    第一版这里直接 return，进程当场结束，那几下点击就**没有落地**
            //    （日志里连"窗口收到按下"都没有）。留一点时间让它走完。
            Thread.Sleep(1200);
        }

        /// <summary>`(x,y)` 上现在是哪个窗口（排查"点击怎么没落到该落的窗口上"）</summary>
        static string At(int x, int y)
        {
            try
            {
                var h = WindowFromPoint(new POINT { X = x, Y = y });
                return "  该点窗口=#" + h.ToInt64() + " " + ClassOf(h);
            }
            catch { return ""; }
        }

        static void Click()
        {
            ClickOnce();        }

        public static void Run(string file)        {
            var probe = new Window
            {
                Width = 420,
                Height = 320,
                Left = 120,                     // DIP
                Top = 120,
                WindowStyle = WindowStyle.None,
                Background = new SolidColorBrush(Color.FromRgb(20, 90, 45)),
                Topmost = true,                 // ⚠️ 必须置顶：否则会被别的普通窗口（比如开着的浏览器）挡住，
                                                //    实验就变成"点到了浏览器"，结论全是假的（踩过一次）
                ShowInTaskbar = false,
                Title = "点透自检目标窗口",
            };
            File.WriteAllText(file, "start " + DateTime.Now.ToString("HH:mm:ss.fff") + Environment.NewLine, Encoding.UTF8);
            probe.MouseLeftButtonDown += (s, e) =>
            {
                File.AppendAllText(file, "down " + DateTime.Now.ToString("HH:mm:ss.fff") + Environment.NewLine, Encoding.UTF8);
            };

            // 5 秒后才点：这样调用方可以先起这个窗口、再起气泡层（后起的置顶窗口在上）
            var click = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(5000) };
            click.Tick += (s, e) =>
            {
                click.Stop();
                try
                {
                    // ⚠️ `SetCursorPos`/`mouse_event` 用的是**物理像素**，窗口位置是 DIP
                    var scale = 1.0;
                    try { scale = VisualTreeHelper.GetDpi(probe).DpiScaleX; } catch { /* 按 1.0 */ }
                    var x = (int)((probe.Left + probe.Width / 2) * scale);
                    var y = (int)((probe.Top + probe.Height / 2) * scale);
                    // ⚠️ 先问清楚"这个点上**实际**是谁"：`WindowFromPoint` 会跳过
                    //    带 WS_EX_TRANSPARENT 的窗口 —— 所以它就是"点透到底生效没有"的答案。
                    var mine = new WindowInteropHelper(probe).Handle;
                    var pt = new POINT { X = x, Y = y };
                    var under = WindowFromPoint(pt);
                    POINT now;
                    GetCursorPos(out now);
                    File.AppendAllText(file, "click@" + x + "," + y
                        + " under=#" + under.ToInt64() + " class=" + ClassOf(under)
                        + " ex=0x" + GetWindowLong(under, -20).ToString("X8")
                        + " mine=#" + mine.ToInt64()
                        + " cursor=" + now.X + "," + now.Y + Environment.NewLine, Encoding.UTF8);
                    // 用 SendInput 移动 + 点击（SetCursorPos 在这个进程里会静默失败，见 MoveAndClick）
                    var ok = MoveAndClick(x, y);
                    GetCursorPos(out now);
                    File.AppendAllText(file, "sent=" + ok
                        + " cursorAfter=" + now.X + "," + now.Y + Environment.NewLine, Encoding.UTF8);
                }
                catch (Exception ex) { File.AppendAllText(file, "err " + ex.Message + Environment.NewLine, Encoding.UTF8); }
            };

            var done = new DispatcherTimer { Interval = TimeSpan.FromSeconds(7) };
            done.Tick += (s, e) =>
            {
                done.Stop();
                var text = File.ReadAllText(file, Encoding.UTF8);
                var hit = text.Contains("down ");
                File.AppendAllText(file, (hit ? "RESULT=hit" : "RESULT=miss") + Environment.NewLine, Encoding.UTF8);
                probe.Close();
            };

            click.Start();
            done.Start();
            new Application().Run(probe);
        }
    }

    // -------------------------------------------------------------------------
    // 服务端调用（快速编辑框用；气泡层自己那条 SendAsync 还在窗口里）
    // -------------------------------------------------------------------------
    static class Api
    {
        /// <summary>把服务端返回的错误体（`{"error":"…"}`）变成一句人话</summary>
        public static string Explain(Exception ex)
        {
            var we = ex as WebException;
            if (we != null && we.Response != null)
            {
                try
                {
                    using (var s = we.Response.GetResponseStream())
                    using (var r = new StreamReader(s, Encoding.UTF8))
                    {
                        var text = r.ReadToEnd();
                        try
                        {
                            var d = new JavaScriptSerializer().DeserializeObject(text) as Dictionary<string, object>;
                            if (d != null && d.ContainsKey("error") && d["error"] != null) return Convert.ToString(d["error"]);
                        }
                        catch { /* 不是 JSON 就把原文给出去 */ }
                        if (!string.IsNullOrEmpty(text)) return text;
                    }
                }
                catch { /* 读不到就用异常自己的话 */ }
            }
            return ex.Message;
        }

        /// <summary>GET/POST/PATCH/DELETE。回调在**线程池线程**上，调用方自己 Dispatcher.Invoke。</summary>
        public static void Call(string url, string method, string path, string body,
            Action<string> ok, Action<Exception> err)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    string text;
                    using (var wc = new WebClient())
                    {
                        wc.Encoding = Encoding.UTF8;
                        wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                        text = (method == "GET")
                            ? wc.DownloadString(url + path)
                            : wc.UploadString(url + path, method, body ?? "{}");
                    }
                    if (ok != null) ok(text);
                }
                catch (Exception ex) { if (err != null) err(ex); }
            });
        }
    }

    // -------------------------------------------------------------------------
    // 快速编辑框
    // -------------------------------------------------------------------------
    /// <summary>
    /// 桌面上那个**编辑框**（用户第 42 轮的要求，原话：
    /// "这个编辑可以直接调用程序不，不要弹网页，也不要弹程序界面，我只要弹编辑框"）。
    ///
    /// ⚠️ 所以单击泡泡**不再**去开浏览器，而是弹这个窗口；里面只放常用几项
    ///    （标题 / 时间 / 等级 / 地点 / 备注）+ 保存/完成/删除。
    ///    要改重复、提醒、未来泡泡那些，窗口里留了「完整编辑器」这个出口
    ///    —— **不在这里重写一整套编辑器**（那会变成第二份实现，迟早和网页那份不一致）。
    ///
    /// ⚠️ 这个窗口里**没有任何业务判断**：等级能选哪几档由 core 给的 `levelOptions` /
    ///    `childLevels` 决定，存进去之后的一切规范化（期限、时间、等级）都在服务端 core。
    /// </summary>
    class EditWindow : Window
    {
        readonly Options _opt;
        readonly BubbleLayer _owner;
        readonly BubbleDto _bubble;          // 编辑已有的泡泡
        readonly ContainerDto _parent;       // 或者：往这个容器里新建子气泡
        readonly List<LevelDto> _levels;

        readonly TextBox _title = new TextBox();
        // ⚠️ 日期用**普通输入框**而不是 WPF 的 `DatePicker`：
        //    DatePicker 内部那个日历按钮和文本框是系统主题画的，在深色卡片上是一块白疙瘩，
        //    要改就得整套重写模板。文本框 + "yyyy-MM-dd" 反而和别的字段一致，也更好测。
        readonly TextBox _dateT = new TextBox();
        readonly TextBox _startT = new TextBox();
        readonly TextBox _endT = new TextBox();
        readonly TextBox _location = new TextBox();
        readonly TextBox _notes = new TextBox();
        readonly TextBlock _error = new TextBlock();
        readonly Dictionary<string, Border> _levelButtons = new Dictionary<string, Border>();
        readonly List<string> _allowed;
        /// <summary>最后打开的那个编辑框（`--shot` 要拿它拍一张图；没有别的用途）</summary>
        public static EditWindow Last = null;
        string _levelKey;
        bool _busy;

        public EditWindow(Options opt, BubbleLayer owner, BubbleDto bubble, ContainerDto parent, List<LevelDto> levels)
        {
            _opt = opt;
            _owner = owner;
            _bubble = bubble;
            _parent = parent;
            _levels = levels != null ? levels : new List<LevelDto>();

            // 能选哪几档：
            //   · 编辑已有泡泡 → core 给的 levelOptions
            //   · 新建子气泡   → 容器的 childLevels
            //   · 新建最外层   → 四档**全都能选**（没有任何父容器约束）
            _allowed = bubble != null
                ? (bubble.levelOptions != null ? bubble.levelOptions : new List<string>())
                : (parent != null
                    ? (parent.childLevels != null ? parent.childLevels : new List<string>())
                    : AllLevelKeys());
            _levelKey = bubble != null ? bubble.levelKey : (_allowed.Count > 0 ? _allowed[0] : "sky");

            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ShowInTaskbar = false;
            ResizeMode = ResizeMode.NoResize;
            SizeToContent = SizeToContent.Height;
            Width = 440;
            Topmost = true;
            Title = bubble != null ? "编辑日程" : (parent != null ? "新建子气泡" : "新建日程");
            WindowStartupLocation = WindowStartupLocation.CenterScreen;

            Content = BuildCard();

            // 初始值
            if (bubble != null)
            {
                _title.Text = bubble.title;
                LoadEvent();
            }
            else
            {
                var start = DateTime.Now.AddHours(1);
                start = new DateTime(start.Year, start.Month, start.Day, start.Hour, 0, 0);
                SetWhen(start, start.AddHours(1));
            }
            PaintLevels();
            Last = this;
            // Esc 也能关：万一鼠标被别的窗口抢着（这一层是置顶全屏的），键盘是最后的退路
            PreviewKeyDown += (s, e) => { if (e.Key == Key.Escape) { e.Handled = true; Close(); } };
            Loaded += (s, e) => { _title.Focus(); _title.SelectAll(); };
            Closed += (s, e) => { if (Last == this) Last = null; };
        }

        /// <summary>四档等级的键（新建最外层时全都能选）—— 表还是 core 给的那一份</summary>
        List<string> AllLevelKeys()
        {
            var keys = new List<string>();
            foreach (var lv in _levels) keys.Add(lv.key);
            // 拿不到等级表时兜底给最小档（宁可只让选一个，也不要给出一堆没颜色的空按钮）
            if (keys.Count == 0) keys.Add("sky");
            return keys;
        }

        // ---------------- 界面 ----------------
        FrameworkElement BuildCard()
        {
            var stack = new StackPanel { Margin = new Thickness(16, 12, 16, 14) };
            stack.Children.Add(Header());

            stack.Children.Add(Label("标题"));
            StyleBox(_title);
            _title.FontSize = 15;
            stack.Children.Add(_title);

            stack.Children.Add(Label("时间"));
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            _dateT.Width = 118;
            _dateT.Margin = new Thickness(0, 0, 8, 0);
            StyleBox(_dateT);
            _dateT.ToolTip = "日期，像 2026-09-25 这样";
            _startT.Width = 62;
            _endT.Width = 62;
            StyleBox(_startT);
            StyleBox(_endT);
            row.Children.Add(_dateT);
            row.Children.Add(_startT);
            row.Children.Add(new TextBlock { Text = "→", Foreground = Brushes.White, Opacity = 0.6, Margin = new Thickness(8, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center });
            row.Children.Add(_endT);
            stack.Children.Add(row);

            stack.Children.Add(Label("事情多大（颜色）"));
            stack.Children.Add(BuildLevelRow());

            stack.Children.Add(Label("地点"));
            StyleBox(_location);
            stack.Children.Add(_location);

            stack.Children.Add(Label("备注"));
            StyleBox(_notes);
            _notes.AcceptsReturn = true;
            _notes.TextWrapping = TextWrapping.Wrap;
            _notes.Height = 56;
            _notes.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            stack.Children.Add(_notes);

            _error.Foreground = new SolidColorBrush(Color.FromRgb(248, 113, 113));
            _error.FontSize = 12;
            _error.Margin = new Thickness(0, 8, 0, 0);
            _error.TextWrapping = TextWrapping.Wrap;
            _error.Visibility = Visibility.Collapsed;
            stack.Children.Add(_error);

            var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 12, 0, 0) };
            buttons.Children.Add(Btn("保存", true, Save));
            if (_bubble != null)
            {
                buttons.Children.Add(Btn("戳破", false, Pop));
                buttons.Children.Add(Btn("删除", false, Delete));
                buttons.Children.Add(Btn("完整编辑器", false, OpenFullEditor));
            }
            buttons.Children.Add(Btn("取消", false, Close));
            stack.Children.Add(buttons);

            return new Border
            {
                Background = new SolidColorBrush(Color.FromArgb(246, 16, 21, 32)),
                BorderBrush = new SolidColorBrush(Color.FromArgb(70, 255, 255, 255)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(14),
                Child = stack,
            };
        }

        FrameworkElement Header()
        {
            var t = new TextBlock
            {
                Text = _bubble != null
                    ? "编辑日程"
                    : (_parent != null ? "往「" + _parent.title + "」里加一个" : "新建日程"),
                Foreground = new SolidColorBrush(Color.FromArgb(240, 255, 255, 255)),
                FontSize = 14, FontWeight = FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 320,
            };
            var close = new TextBlock
            {
                Text = "✕", Foreground = new SolidColorBrush(Color.FromArgb(200, 255, 255, 255)),
                FontSize = 14, Margin = new Thickness(10, 0, 2, 0), Cursor = Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Center,
                ToolTip = "关闭（Esc 也行）",
            };
            // ⚠️⚠️ 必须用 **PreviewMouseLeftButtonDown + Handled**，而且要**按下就关**：
            //    这个 ✕ 在表头里面，而表头按下去会走 `DragMove()` ——
            //    DragMove 会开一个模态拖动循环并抢走鼠标捕获，
            //    于是"等 MouseUp 才触发"的写法**永远等不到那一下**：
            //    用户点 ✕ 只会把窗口拖来拖去，**关不掉**（他就这么报的）。
            //    Preview 阶段先吃掉，DragMove 就轮不到它了。
            close.PreviewMouseLeftButtonDown += (s, e) => { e.Handled = true; Close(); };
            var right = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            right.Children.Add(close);

            var g = new Grid { Margin = new Thickness(0, 0, 0, 10) };
            g.Children.Add(t);
            g.Children.Add(right);
            // 拖这块 = 挪窗口（和系统标题栏一个用法）。
            // ⚠️ 只在**按在表头自己（或标题文字）**上时才拖：按在 ✕ 上不拖（上面前面已经拦住）
            g.MouseLeftButtonDown += (s, e) =>
            {
                if (e.OriginalSource != g && e.OriginalSource != t) return;
                try { DragMove(); } catch { /* 某些输入状态下会抛 */ }
            };
            return g;
        }

        static TextBlock Label(string text)
        {
            return new TextBlock
            {
                Text = text, FontSize = 11.5,
                Foreground = new SolidColorBrush(Color.FromArgb(170, 255, 255, 255)),
                Margin = new Thickness(0, 10, 0, 4),
            };
        }

        static void StyleBox(TextBox box)
        {
            box.Background = new SolidColorBrush(Color.FromArgb(255, 26, 32, 46));
            box.Foreground = Brushes.White;
            box.BorderBrush = new SolidColorBrush(Color.FromArgb(60, 255, 255, 255));
            box.BorderThickness = new Thickness(1);
            box.Padding = new Thickness(7, 5, 7, 5);
            box.FontSize = 13;
            box.CaretBrush = Brushes.White;
        }

        FrameworkElement BuildLevelRow()
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            foreach (var lv in _levels)
            {
                // 只画 core 说"可以选"的那几档
                if (!_allowed.Contains(lv.key)) continue;
                var b = new Border
                {
                    Padding = new Thickness(10, 5, 10, 5),
                    Margin = new Thickness(0, 0, 8, 0),
                    CornerRadius = new CornerRadius(8),
                    BorderThickness = new Thickness(2),
                    Cursor = Cursors.Hand,
                    Background = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)),
                    Child = new TextBlock
                    {
                        Text = lv.label + "　" + lv.key,
                        FontSize = 12.5,
                        Foreground = new SolidColorBrush(BubbleVisual.Col(lv.color)),
                    },
                };
                var key = lv.key;                                   // ⚠️ C# 5 里闭包要自己抓一份
                b.MouseLeftButtonUp += (s, e) => { _levelKey = key; PaintLevels(); };
                _levelButtons[key] = b;
                row.Children.Add(b);
            }
            if (_levelButtons.Count == 0)
            {
                row.Children.Add(new TextBlock
                {
                    Text = "（这一层没有可选的颜色档）", FontSize = 12,
                    Foreground = new SolidColorBrush(Color.FromArgb(170, 255, 255, 255)),
                });
            }
            return row;
        }

        void PaintLevels()
        {
            foreach (var kv in _levelButtons)
            {
                var lv = FindLevel(kv.Key);
                var col = lv != null ? BubbleVisual.Col(lv.color) : Colors.White;
                var on = kv.Key == _levelKey;
                kv.Value.BorderBrush = new SolidColorBrush(on ? col : Color.FromArgb(0, 0, 0, 0));
                kv.Value.Background = new SolidColorBrush(on
                    ? Color.FromArgb(70, col.R, col.G, col.B)
                    : Color.FromArgb(26, 255, 255, 255));
            }
        }

        LevelDto FindLevel(string key)
        {
            foreach (var lv in _levels) if (lv.key == key) return lv;
            return null;
        }

        static Button Btn(string text, bool primary, Action onClick)
        {
            var b = new Button
            {
                Content = text,
                Padding = new Thickness(12, 6, 12, 6),
                Margin = new Thickness(0, 0, 8, 0),
                FontSize = 13,
                Cursor = Cursors.Hand,
                Background = new SolidColorBrush(primary
                    ? Color.FromRgb(56, 130, 246)
                    : Color.FromArgb(38, 255, 255, 255)),
                Foreground = Brushes.White,
                BorderThickness = new Thickness(0),
            };
            b.Click += (s, e) => onClick();
            return b;
        }

        void Fail(string msg)
        {
            _error.Text = msg;
            _error.Visibility = Visibility.Visible;
        }

        // ---------------- 读写 ----------------
        void LoadEvent()
        {
            Api.Call(_opt.Url, "GET", "/api/state", null,
                text =>
                {
                    Dispatcher.Invoke(() =>
                    {
                        try
                        {
                            var st = new JavaScriptSerializer().Deserialize<StateDto>(text);
                            EventDto ev = null;
                            if (st != null && st.events != null)
                                foreach (var e in st.events) if (e.id == _bubble.id) { ev = e; break; }
                            if (ev == null) { Fail("这条日程已经不在了"); return; }
                            _title.Text = ev.title ?? "";
                            _location.Text = ev.location ?? "";
                            _notes.Text = ev.notes ?? "";
                            var lv = !string.IsNullOrEmpty(ev.level) ? ev.level : ev.tier;
                            if (!string.IsNullOrEmpty(lv) && _levelButtons.ContainsKey(lv)) _levelKey = lv;
                            DateTime s;
                            DateTime en;
                            if (DateTime.TryParse(ev.start, out s))
                            {
                                if (!DateTime.TryParse(ev.end, out en) || en <= s) en = s.AddHours(1);
                                SetWhen(s, en);
                            }
                            PaintLevels();
                        }
                        catch (Exception ex) { Fail("读这条日程失败：" + ex.Message); }
                    });
                },
                ex => Dispatcher.Invoke(() => Fail("连不上本地服务：" + Api.Explain(ex))));
        }

        void SetWhen(DateTime start, DateTime end)
        {
            _dateT.Text = start.ToString("yyyy-MM-dd");
            _startT.Text = start.ToString("HH:mm");
            _endT.Text = end.ToString("HH:mm");
        }

        /// <summary>把"日期框 + 两个 HH:mm"拼回绝对时刻（中文冒号也认）</summary>
        bool TryParseWhen(out DateTime start, out DateTime end)
        {
            start = DateTime.MinValue;
            end = DateTime.MinValue;
            DateTime day;
            if (!TryDate(_dateT.Text, out day)) { Fail("日期填得不对（像 2026-09-25 这样）"); return false; }
            TimeSpan ts;
            TimeSpan te;
            if (!TryTime(_startT.Text, out ts)) { Fail("开始时间填得不对（像 15:30 这样）"); return false; }
            if (!TryTime(_endT.Text, out te)) { Fail("结束时间填得不对（像 16:30 这样）"); return false; }
            start = day.Date.Add(ts);
            end = day.Date.Add(te);
            if (end <= start) { Fail("结束时间要晚于开始时间"); return false; }
            return true;
        }

        /// <summary>认几种常见写法：2026-09-25 / 2026/9/25 / 9-25（当年）</summary>
        static bool TryDate(string raw, out DateTime day)
        {
            day = DateTime.MinValue;
            var s = (raw ?? "").Trim().Replace('/', '-').Replace('年', '-').Replace('月', '-').Replace("日", "");
            if (s.Length == 0) return false;
            if (DateTime.TryParse(s, CultureInfo.CurrentCulture, DateTimeStyles.None, out day)) return true;
            if (DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out day)) return true;
            return false;
        }

        static bool TryTime(string raw, out TimeSpan t)
        {
            t = TimeSpan.Zero;
            var s = (raw ?? "").Trim().Replace('：', ':').Replace("点", ":");
            if (s.EndsWith(":")) s = s.TrimEnd(':');
            if (TimeSpan.TryParse(s, CultureInfo.InvariantCulture, out t)) return t.TotalHours < 24;
            // 只填了小时（"9"）也认
            double h;
            if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out h) && h >= 0 && h < 24)
            {
                t = TimeSpan.FromHours(h);
                return true;
            }
            return false;
        }

        string Body()
        {
            DateTime day;
            TryDate(_dateT.Text, out day);
            TimeSpan ts, te;
            TryTime(_startT.Text, out ts);
            TryTime(_endT.Text, out te);
            var start = day.Date.Add(ts);
            var end = day.Date.Add(te);
            var d = new Dictionary<string, object>();
            d["title"] = _title.Text.Trim();
            d["start"] = start.ToString("yyyy-MM-ddTHH:mm:00");
            d["end"] = end.ToString("yyyy-MM-ddTHH:mm:00");
            d["level"] = _levelKey;
            d["location"] = _location.Text.Trim();
            d["notes"] = _notes.Text.Trim();
            if (_bubble == null && _parent != null) d["parentId"] = _parent.id;
            return new JavaScriptSerializer().Serialize(d);
        }

        void Save()
        {
            if (_busy) return;
            if (string.IsNullOrEmpty(_title.Text.Trim())) { Fail("标题不能空"); return; }
            DateTime s, e;
            if (!TryParseWhen(out s, out e)) return;
            _error.Visibility = Visibility.Collapsed;
            _busy = true;
            var body = Body();
            if (_bubble != null)
            {
                Api.Call(_opt.Url, "PATCH", "/api/events/" + Uri.EscapeDataString(_bubble.id), body,
                    text => Dispatcher.Invoke(() => { _busy = false; Done("已保存"); }),
                    ex => Dispatcher.Invoke(() => { _busy = false; Fail("保存失败：" + Api.Explain(ex)); }));
            }
            else
            {
                Api.Call(_opt.Url, "POST", "/api/events", body,
                    text => Dispatcher.Invoke(() => { _busy = false; Done("已加进这个泡泡"); }),
                    ex => Dispatcher.Invoke(() => { _busy = false; Fail("新建失败：" + Api.Explain(ex)); }));
            }
        }

        /// <summary>戳破（长按 2.5 秒那条路的"按钮版"）—— 按实例记账，要带上日期和剩余时间</summary>
        void Pop()
        {
            if (_busy || _bubble == null) return;
            _busy = true;
            var d = new Dictionary<string, object>();
            if (!string.IsNullOrEmpty(_bubble.occurrence)) d["occurrence"] = _bubble.occurrence;
            if (_bubble.remainingMs.HasValue) d["remainingMs"] = _bubble.remainingMs.Value;
            Api.Call(_opt.Url, "POST", "/api/events/" + Uri.EscapeDataString(_bubble.id) + "/pop",
                new JavaScriptSerializer().Serialize(d),
                text => Dispatcher.Invoke(() => { _busy = false; Done("已戳破"); }),
                ex => Dispatcher.Invoke(() => { _busy = false; Fail("戳破失败：" + Api.Explain(ex)); }));
        }

        void Delete()
        {
            if (_busy || _bubble == null) return;
            _busy = true;
            Api.Call(_opt.Url, "DELETE", "/api/events/" + Uri.EscapeDataString(_bubble.id), null,
                text => Dispatcher.Invoke(() => { _busy = false; Done("已删除"); }),
                ex => Dispatcher.Invoke(() => { _busy = false; Fail("删除失败：" + Api.Explain(ex)); }));
        }

        /// <summary>
        /// 出口：真要改重复 / 提醒 / 未来泡泡那些，去网页那个完整编辑器。
        /// ⚠️ 故意**不在这个窗口里重写**一整套编辑器 —— 两份实现迟早不一致。
        /// </summary>
        void OpenFullEditor()
        {
            try
            {
                System.Diagnostics.Process.Start(_opt.Url + "/index.html?open=" + Uri.EscapeDataString(_bubble.id));
                Close();
            }
            catch (Exception ex) { Fail("打不开浏览器：" + ex.Message); }
        }

        void Done(string msg)
        {
            if (_owner != null) _owner.OnEdited(msg);
            Close();
        }
    }

    // -------------------------------------------------------------------------
    // --selftest：把**整层**渲染成一张 PNG（不开窗口、**不抓用户的屏幕**）
    //
    // 为什么要它：原生的"画得对不对"没法用单元测试验；而在用户桌面上截屏既没必要
    // 又侵犯隐私。所以让程序**自己把自己画到一张位图上**，任何人（包括未来的我）
    // 都能直接看图确认。
    //
    // 这张图故意画**两个场景**并排：
    //   左：最外层（全屏透明层里只有泡泡，背景是壁纸）
    //   右：进了一个母泡泡（那个圈 + **圈里是模糊的壁纸** + 容器色的柔光 + 圈边 + 顶上的 HUD）
    // 右半边就是这一轮用户要的"有母泡泡背景、背景要虚化"的样子。
    // -------------------------------------------------------------------------
    static class SelfTest
    {
        public static void Render(string outPath)
        {
            const int SW = 640, SH = 520;                 // 每个场景
            const int W = SW * 2 + 24, H = SH;            // 两张并排 + 中间一条缝
            var root = new Canvas { Width = W, Height = H, Background = new SolidColorBrush(Color.FromRgb(10, 12, 18)) };

            DrawScene(root, 0, 0, SW, SH, false);
            DrawScene(root, SW + 24, 0, SW, SH, true);

            root.Measure(new Size(W, H));
            root.Arrange(new Rect(0, 0, W, H));
            var bmp = new RenderTargetBitmap(W, H, 96, 96, PixelFormats.Pbgra32);
            bmp.Render(root);
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(bmp));
            var full = IOPath.GetFullPath(outPath);
            Directory.CreateDirectory(IOPath.GetDirectoryName(full));
            using (var fs = File.Create(full)) enc.Save(fs);
            Console.WriteLine("selftest 已写出 " + full);
        }

        /// <summary>一个场景：底下的假壁纸 + （可选）母泡泡那个圈 + 几颗泡泡</summary>
        static void DrawScene(Canvas root, double ox, double oy, double w, double h, bool inside)
        {
            var wall = FakeWallpaper(w, h);
            Canvas.SetLeft(wall, ox);
            Canvas.SetTop(wall, oy);
            root.Children.Add(wall);

            var demo = new List<BubbleDto>
            {
                Mock("a", "大学物理实验作业", "已过 6 小时 39 分", "09:02", 64, "#5b2a6e", "#ffffff", true, 2),
                Mock("b", "跨文化交际 canvas 阅读", "剩余 23 小时 48 分", "周五 15:32", 42, "#38bdf8", "#161c2a", false, 0),
                Mock("c", "中秋任务合集", "剩余 38 分 50 秒", "00:22", 52, "#f5b301", "#161c2a", false, 2),
                Mock("d", "还剩两周的事", "剩余 14 天", "周三 10:00", 34, "#22c55e", "#161c2a", false, 1),
            };

            if (inside)
            {
                // 母泡泡那个圈：**什么都不画**，只有一层淡淡的颜色 ——
                // 底下的"桌面"（这里是一张假壁纸）原样透出来，和真机上一样。
                // ⚠️ 这里原来画的是"把壁纸模糊一份贴进圈里"，用户第 43 轮否掉了：
                //    "你别画桌面啊，你只要背景淡化透明就好了啊"。
                var container = new ContainerDto
                {
                    id = "p", title = "跨文化交际（母泡泡）", levelKey = "amber",
                    fill = "#f5b301", fillLight = "#fde68a", fillDark = "#7c5a02",
                    edge = "#c98f00", overdue = false, readOnly = false,
                };
                var circle = BubbleVisual.BuildParentCircle(container, w, h);
                Canvas.SetLeft(circle, ox);
                Canvas.SetTop(circle, oy);
                root.Children.Add(circle);

                // HUD（左上角那一格，和窗口里一样：面包屑 + 提示）
                var hudText = new TextBlock
                {
                    Text = "跨文化交际（母泡泡）\n单击背景加子气泡 · 拖动气泡到别的气泡上可放进去 · 拖到圈外就是拉出来 · 双击背景出去",
                    Foreground = new SolidColorBrush(Color.FromArgb(240, 255, 255, 255)),
                    FontSize = 11.5, TextWrapping = TextWrapping.Wrap, MaxWidth = 380,
                };
                var hud = new Border
                {
                    Background = new SolidColorBrush(Color.FromArgb(150, 12, 16, 26)),
                    BorderBrush = new SolidColorBrush(Color.FromArgb(48, 255, 255, 255)),
                    BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10),
                    Padding = new Thickness(10, 6, 10, 6), Child = hudText,
                };
                hud.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                Canvas.SetLeft(hud, ox + 12); Canvas.SetTop(hud, oy + 10);
                root.Children.Add(hud);
            }

            var spots = new[]
            {
                new Point(0.32, 0.30), new Point(0.70, 0.26),
                new Point(0.36, 0.70), new Point(0.72, 0.68),
            };
            for (int i = 0; i < demo.Count; i++)
            {
                var el = BubbleVisual.Build(demo[i]);
                var half = el.Width / 2;
                Canvas.SetLeft(el, ox + w * spots[i].X - half);
                Canvas.SetTop(el, oy + h * spots[i].Y - half);
                root.Children.Add(el);
            }
        }

        /// <summary>假"桌面壁纸"：深浅渐变 + 两条斜带（用来看"虚化/透明"到什么程度）</summary>
        static FrameworkElement FakeWallpaper(double w, double h)
        {
            var host = new Canvas { Width = w, Height = h, IsHitTestVisible = false };
            var wall = new Rectangle { Width = w, Height = h };
            var wg = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(1, 1) };
            wg.GradientStops.Add(new GradientStop(Color.FromRgb(41, 62, 96), 0));
            wg.GradientStops.Add(new GradientStop(Color.FromRgb(96, 74, 112), 0.55));
            wg.GradientStops.Add(new GradientStop(Color.FromRgb(30, 34, 48), 1));
            wall.Fill = wg;
            host.Children.Add(wall);
            for (var i = 0; i < 2; i++)
            {
                var band = new Rectangle
                {
                    Width = w * 1.4, Height = 40,
                    Fill = new SolidColorBrush(Color.FromArgb((byte)(i == 0 ? 70 : 40), 255, 255, 255)),
                    RenderTransform = new RotateTransform(-18 + i * 26, w / 2, h / 2),
                };
                Canvas.SetLeft(band, -w * 0.2);
                Canvas.SetTop(band, 110 + i * 210);
                host.Children.Add(band);
            }
            return host;
        }

        static BubbleDto Mock(string id, string title, string cd, string when, double r,
            string fill, string text, bool overdue, int childLevels)
        {
            var levels = new List<string>();
            if (childLevels >= 1) levels.Add("sky");
            if (childLevels >= 2) levels.Add("emerald");
            if (childLevels >= 3) levels.Add("amber");
            return new BubbleDto
            {
                id = id, key = id + "@2026-09-25", title = title, countdown = cd, when = when, r = r, seed = 0.3,
                fill = fill, fillLight = "#ffffff", fillDark = "#0b1220", edge = "#111827",
                text = text, ring = null, overdue = overdue, ownOverdue = overdue,
                inheritedOverdue = false, levelKey = "sky", dimmed = false,
                canHold = childLevels > 0, childLevels = levels,
                occurrence = "2026-09-25", remainingMs = 1234567,
            };
        }
    }
}
