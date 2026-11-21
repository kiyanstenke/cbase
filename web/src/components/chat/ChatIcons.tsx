
// ── Icons (inline SVG, no emojis) ───────────────────────────────────────────
const svg = (children: React.ReactNode, size = 15) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const SearchIcon = () => svg(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.6-3.6" /></>, 15);
// Collapse/expand the list.
const PanelCloseIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="m15.5 9.5-2.5 2.5 2.5 2.5" /></>, 16);
const PanelOpenIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="m13 9.5 2.5 2.5-2.5 2.5" /></>, 16);
const KebabIcon = () => svg(<><circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" /></>, 16);
const PinIcon = () => svg(<><path d="M12 17v5" /><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z" /></>, 14);
const PencilIcon = () => svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></>);
const ForkIcon = () => svg(<><circle cx="6" cy="4" r="2" /><circle cx="6" cy="20" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 6v12" /><path d="M18 9a6 6 0 0 1-6 6H6" /></>, 14);
const FolderIcon = () => svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />);
// Chat folder: filled tab + stronger outline, so a folder row in the list is NOT mistaken for a chat at first glance. Open =
// opened front flap.
const FolderSolidIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="currentColor" fillOpacity="0.22" />
    <path d="M3 9.5h18" />
  </svg>
);
const FolderOpenIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z" fill="currentColor" fillOpacity="0.22" />
    <path d="M3 10h18.2a1 1 0 0 1 .97 1.24l-1.5 6A2 2 0 0 1 18.72 19H5a2 2 0 0 1-2-2v-7z" fill="currentColor" fillOpacity="0.12" />
  </svg>
);
const FolderPlusIcon = () => svg(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><path d="M12 11v5" /><path d="M9.5 13.5h5" /></>, 16);

const BubblePlusIcon = () => svg(<><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5z" /><path d="M12 8v6" /><path d="M9 11h6" /></>, 14);
const TrashIcon = () => svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></>);
const CheckIcon = () => svg(<path d="M20 6L9 17l-5-5" />, 14);

const ChevronRightIcon = () => svg(<path d="M9 18l6-6-6-6" />, 14);
const CaretDown = () => svg(<path d="M6 9l6 6 6-6" />, 13);

// The bare plus of the composer (attachment).
const PlusIcon = () => svg(<><path d="M12 5v14" /><path d="M5 12h14" /></>, 20);
// Collapse/compact (arrows pointing inward).
const CompressIcon = () => svg(<><path d="M4 9l4 0 0-4" /><path d="M20 9l-4 0 0-4" /><path d="M4 15l4 0 0 4" /><path d="M20 15l-4 0 0 4" /></>, 13);
// Hexagon (cbase) for the hero greeting, the header and, with `size="1em"`, the working indicator and the figures line
// (chat/RunDisplay.tsx): there it grows with the text.
const CbIcon = ({ size = 28, filled = false }: { size?: number | string; filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden>
    <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5z" />
  </svg>
);
const PulseIcon = () => svg(<path d="M22 12h-4l-3 8-6-16-3 8H2" />, 15);
const HistoryIcon = ({ size = 15 }: { size?: number } = {}) => svg(<><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" /></>, size);

const FileIcon = () => svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>, 14);
const XIcon = () => svg(<><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>, 10);
const ShieldIcon = () => svg(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />, 13);
// Effort (gauge) and browser (window): icons, so the control row works without labels in narrow windows and still stays on ONE line.
const GaugeIcon = () => svg(<><path d="M4 18a8 8 0 1 1 16 0" /><path d="M12 18l4.5-5" /></>, 14);
const WindowIcon = () => svg(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" /><circle cx="6.5" cy="6.5" r=".6" fill="currentColor" stroke="none" /></>, 14);
// Handles and states of the dynamic workflows (chat/DynWorkflowTree.tsx): buttons as icons instead of words (the word is in
// aria-label and title), one state icon per agent before the row. Size is a parameter because the same icons appear in the row and
// the header.
const StopSquareIcon = ({ size = 12 }: { size?: number }) => svg(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />, size);
const RestartIcon = ({ size = 12 }: { size?: number }) => svg(<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>, size);
const SkipForwardIcon = ({ size = 12 }: { size?: number }) => svg(<><path d="M5 4.5l10 7.5-10 7.5z" /><path d="M19 5v14" /></>, size);
// "Message" to a living agent: a speech bubble with two lines.
const MessageIcon = ({ size = 12 }: { size?: number }) => svg(<><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z" /><path d="M8 8.5h8" /><path d="M8 11.5h5" /></>, size);
const CircleCheckIcon = ({ size = 13 }: { size?: number }) => svg(<><circle cx="12" cy="12" r="9" /><path d="m8.5 12.3 2.4 2.4 4.6-4.9" /></>, size);
const CircleXIcon = ({ size = 13 }: { size?: number }) => svg(<><circle cx="12" cy="12" r="9" /><path d="m14.8 9.2-5.6 5.6" /><path d="m9.2 9.2 5.6 5.6" /></>, size);
const CircleDashedIcon = ({ size = 13 }: { size?: number }) => svg(<circle cx="12" cy="12" r="9" strokeDasharray="3.2 3.4" />, size);
const CircleSkipIcon = ({ size = 13 }: { size?: number }) => svg(<><circle cx="12" cy="12" r="9" /><path d="m9.5 9 3.6 3-3.6 3" /><path d="M15 9v6" /></>, size);
const CircleStopIcon = ({ size = 13 }: { size?: number }) => svg(<><circle cx="12" cy="12" r="9" /><rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1" fill="currentColor" stroke="none" /></>, size);
const CircleMinusIcon = ({ size = 13 }: { size?: number }) => svg(<><circle cx="12" cy="12" r="9" /><path d="M8.5 12h7" /></>, size);
// The running state spins, only without reduced motion (motion-safe); otherwise the arc stands still.
const SpinnerIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden className="motion-safe:animate-spin">
    <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" />
  </svg>
);
export { BubblePlusIcon, CaretDown, CheckIcon, ChevronRightIcon, CircleCheckIcon, CircleDashedIcon, CircleMinusIcon, CircleSkipIcon, CircleStopIcon, CircleXIcon, CompressIcon, FileIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, FolderSolidIcon, ForkIcon, GaugeIcon, CbIcon, HistoryIcon, KebabIcon, MessageIcon, PanelCloseIcon, PanelOpenIcon, PencilIcon, PinIcon, PlusIcon, PulseIcon, RestartIcon, SearchIcon, ShieldIcon, SkipForwardIcon, SpinnerIcon, StopSquareIcon, TrashIcon, WindowIcon, XIcon, svg };
