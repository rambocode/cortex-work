import ReactDOM from "react-dom/client";
// i18next 单例:Spotlight 是独立渲染进程(裸 React root,无 CoreProvider),import 即在首屏前
// init 本进程默认 zh 单例,使 SpotlightBar 内 useTranslation 可解析。
import { changeLanguage } from "@cortex-work/core/i18n";
import { SpotlightBar } from "./SpotlightBar";
import "./spotlight.css";

// 订阅主进程 locale 广播:用户在主窗口切语言时本浮层(独立 i18next 单例)随之重译。
window.desktopAPI?.personal?.onLocaleChange?.((locale) => void changeLanguage(locale));

ReactDOM.createRoot(document.getElementById("root")!).render(<SpotlightBar />);
