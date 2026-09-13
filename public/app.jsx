/* ============================================================
   Project CUI - Self-hosted IDE
   React frontend: file manager + Monaco editor + xterm terminal
   ============================================================ */

const { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext, Fragment } = React;

/* ---------------- Toasts ---------------- */
function toast(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('nova-toast', { detail: { msg, type, id: Date.now() + Math.random() } }));
}
function ToastRoot() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const h = (e) => {
      const t = e.detail;
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.map((x) => (x.id === t.id ? { ...x, leaving: true } : x))), 3400);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3700);
    };
    window.addEventListener('nova-toast', h);
    return () => window.removeEventListener('nova-toast', h);
  }, []);
  return (
    <div id="toast-root">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.type} ${t.leaving ? 'leaving' : ''}`}>
          <i className={`fas ${t.type === 'error' ? 'fa-circle-exclamation' : t.type === 'success' ? 'fa-circle-check' : 'fa-circle-info'}`} />
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- API helper ---------------- */
async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = localStorage.getItem('pc-token');
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem('pc-token');
    localStorage.removeItem('pc-user');
    window.dispatchEvent(new CustomEvent('nova-auth', { detail: { logout: true } }));
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function wsSendT(wsRef, obj) {
  const ws = wsRef.current;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

/* Text-apply helpers shared by Monaco & the plain-text fallback editor */
function textPosToOffset(text, L, C) {
  const lines = String(text || '').split('\n');
  let off = 0;
  for (let i = 0; i < Math.min(L - 1, lines.length); i++) off += lines[i].length + 1;
  return Math.min(off + (C - 1), String(text || '').length);
}
function applyEditsToText(prev, edits) {
  let out = String(prev || '');
  for (const ed of edits) {
    const A = textPosToOffset(out, ed.range.startLineNumber, ed.range.startColumn);
    const B = textPosToOffset(out, ed.range.endLineNumber, ed.range.endColumn);
    out = out.slice(0, A) + (ed.text || '') + out.slice(Math.max(A, B));
  }
  return out;
}

/* Minimal syntax highlighter for the plain-text fallback editor, so colors
   survive even while/if Monaco is still loading. Colors follow nova-dark. */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hlRulesFor(lang) {
  const r = [];
  const C = (src, cls) => r.push({ src, cls });
  if (lang === 'python' || lang === 'shell' || lang === 'ruby' || lang === 'perl' ||
      lang === 'yaml' || lang === 'dockerfile' || lang === 'r' || lang === 'makefile' ||
      lang === 'powershell' || lang === 'bat' || lang === 'tcl') {
    C('#.*', 'hl-com');                  // hash-first comments
    C('<!--[\\s\\S]*?-->', 'hl-com');
  } else if (lang === 'html' || lang === 'xml' || lang === 'markdown') {
    C('<!--[\\s\\S]*?-->', 'hl-com');    // markup comments
  } else {
    C('\\/\\/.*', 'hl-com');             // C-style comments
    C('\\/\\*[\\s\\S]*?\\*/', 'hl-com');
  }
  C('"(?:[^"\\\\\\n]|\\\\.)*"', 'hl-str');
  if (lang === 'javascript' || lang === 'typescript' || lang === 'python' ||
      lang === 'ruby' || lang === 'php' || lang === 'shell' || lang === 'sql') {
    C("'(?:[^'\\\\\\n]|\\\\.)*'", 'hl-str');
  }
  if (lang === 'javascript' || lang === 'typescript' || lang === 'markdown' || lang === 'html') {
    C('`(?:[^`\\\\\\n]|\\\\.)*`', 'hl-str');
  }
  C('\\b0[xX][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b', 'hl-num');
  C('[&|+\\-*/%=<>!?^~]+', 'hl-op');
  C('\\b(?:const|let|var|function|return|if|else|elif|for|while|do|switch|case|default|break|continue|new|delete|typeof|instanceof|in|of|this|super|class|extends|static|async|await|try|catch|finally|throw|import|export|from|require|def|lambda|yield|pass|and|or|not|is|None|True|False|package|public|private|protected|interface|enum|implements|abstract|readonly|namespace|using|struct|void|int|float|double|bool|string|char|byte|long|short|signed|unsigned|print|printf|global|local|include|define|ifdef|ifndef|endif|then|end|begin|procedure|select|from|where|insert|update|delete|create|table|as|join|on|group|order|by|having|limit|values|into|set|grant|revoke|ssize|size_t|callback|prop|use|fn|let-mut|mut|pub|impl|trait|mod|self|Some|None|Ok|Err|match|let)\\b', 'hl-kw');
  C('\\b(?:true|false|null|undefined|nil|NaN|Infinity)\\b', 'hl-lit');
  if (lang === 'python') C('@\\w+', 'hl-decor');
  C('\\b(?:class|struct|interface|trait|module|def|function|func|fn)\\s+[A-Za-z_$][\\w$]*', 'hl-kw');
  C('[A-Za-z_$][\\w$]*(?=\\s*\\()', 'hl-fn');
  C('\\b[A-Z][A-Za-z0-9_]*\\b', 'hl-type');
  return r;
}

const HL_PLAIN = new Set(['plaintext', 'txt', 'log', 'markdown', 'makefile', 'dockerfile']);
function highlightCode(text, path) {
  const src = String(text || '');
  if (src.length > 400000) return escapeHtml(src);
  const lang = langForPath(path);
  const ext = (path.split('.').pop() || '').toLowerCase();
  const key = ext === 'txt' || ext === 'log' ? ext : lang;
  if (HL_PLAIN.has(key)) return escapeHtml(src);
  const rules = hlRulesFor(lang);
  const master = new RegExp(rules.map((x) => '(' + x.src + ')').join('|'), 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = master.exec(src))) {
    if (m.index > last) out += escapeHtml(src.slice(last, m.index));
    let cls = null;
    for (let i = 0; i < rules.length; i++) {
      if (m[i + 1] !== undefined) { cls = rules[i].cls; break; }
    }
    out += cls ? `<span class="${cls}">${escapeHtml(m[0])}</span>` : escapeHtml(m[0]);
    last = m.index + m[0].length;
    if (m[0].length === 0) master.lastIndex++;
  }
  out += escapeHtml(src.slice(last));
  return out;
}

/* ---------------- File icon mapping ---------------- */
const ICONS = {
  js: ['fa-brands fa-js', '#f7df1e'], jsx: ['fa-brands fa-react', '#22d3ee'], ts: ['fa-brands fa-js', '#3178c6'],
  tsx: ['fa-brands fa-react', '#22d3ee'], json: ['fa-solid fa-brackets-curly', '#b8c832'], html: ['fa-brands fa-html5', '#e34c26'],
  css: ['fa-brands fa-css3-alt', '#2965f1'], scss: ['fa-brands fa-sass', '#cd6799'], md: ['fa-brands fa-markdown', '#7b8aa3'],
  py: ['fa-brands fa-python', '#4b8bbe'], rb: ['fa-solid fa-gem', '#cc342d'], go: ['fa-brands fa-golang', '#00add8'],
  rs: ['fa-brands fa-rust', '#dea584'], java: ['fa-brands fa-java', '#e76f00'], c: ['fa-solid fa-c', '#5a9bd4'],
  h: ['fa-solid fa-h', '#5a9bd4'], cpp: ['fa-brands fa-cpp', '#659ad2'], cs: ['fa-solid fa-c', '#953da1'],
  php: ['fa-brands fa-php', '#777bb4'], sh: ['fa-solid fa-terminal', '#89e051'], bash: ['fa-solid fa-terminal', '#89e051'],
  zsh: ['fa-solid fa-terminal', '#89e051'], yml: ['fa-solid fa-gears', '#cb171e'], yaml: ['fa-solid fa-gears', '#cb171e'],
  xml: ['fa-solid fa-code', '#f16529'], sql: ['fa-solid fa-database', '#e38c00'], sqlite: ['fa-solid fa-database', '#e38c00'],
  txt: ['fa-solid fa-file-lines', '#8c93a8'], log: ['fa-solid fa-file-lines', '#8c93a8'], gitignore: ['fa-brands fa-git-alt', '#f05033'],
  png: ['fa-solid fa-file-image', '#22d3ee'], jpg: ['fa-solid fa-file-image', '#22d3ee'], jpeg: ['fa-solid fa-file-image', '#22d3ee'],
  gif: ['fa-solid fa-file-image', '#22d3ee'], svg: ['fa-solid fa-file-image', '#ffb13b'], ico: ['fa-solid fa-file-image', '#ffb13b'],
  webp: ['fa-solid fa-file-image', '#22d3ee'], avif: ['fa-solid fa-file-image', '#22d3ee'], bmp: ['fa-solid fa-file-image', '#22d3ee'],
  mp4: ['fa-solid fa-file-video', '#fb7185'], m4v: ['fa-solid fa-file-video', '#fb7185'], mov: ['fa-solid fa-file-video', '#fb7185'],
  mkv: ['fa-solid fa-file-video', '#fb7185'], webm: ['fa-solid fa-file-video', '#fb7185'], ogv: ['fa-solid fa-file-video', '#fb7185'],
  mp3: ['fa-solid fa-file-audio', '#a78bfa'], wav: ['fa-solid fa-file-audio', '#a78bfa'], ogg: ['fa-solid fa-file-audio', '#a78bfa'],
  flac: ['fa-solid fa-file-audio', '#a78bfa'], m4a: ['fa-solid fa-file-audio', '#a78bfa'],
  pdf: ['fa-solid fa-file-pdf', '#f40f02'], zip: ['fa-solid fa-file-zipper', '#8c93a8'], tar: ['fa-solid fa-file-zipper', '#8c93a8'],
  gz: ['fa-solid fa-file-zipper', '#8c93a8'], lock: ['fa-solid fa-lock', '#fbbf24'], toml: ['fa-solid fa-gears', '#8c93a8'],
  pc: ['fa-solid fa-file', '#8c93a8'], ps1: ['fa-solid fa-terminal', '#89e051'],
  bat: ['fa-solid fa-terminal', '#89e051'], cmd: ['fa-solid fa-terminal', '#89e051'],
  service: ['fa-solid fa-gear', '#8c93a8'], svelte: ['fa-solid fa-fire', '#ff3e00'],
  dart: ['fa-solid fa-fire', '#0175c2'], kt: ['fa-solid fa-gears', '#7f52ff'],
  vue: ['fa-brands fa-vuejs', '#42b883'], vuex: ['fa-brands fa-vuejs', '#42b883'],
  apk: ['fa-brands fa-android', '#3ddc84'], aab: ['fa-brands fa-android', '#3ddc84'],
  ipa: ['fa-brands fa-apple', '#a2aaad'], swift: ['fa-brands fa-apple', '#f05138'],
  dockerfile: ['fa-brands fa-docker', '#2496ed'], makefile: ['fa-solid fa-hammer', '#f59e0b'],
  dockerignore: ['fa-brands fa-docker', '#2496ed'],
  gradle: ['fa-solid fa-diagram-project', '#019cb7'], groovy: ['fa-solid fa-diagram-project', '#4298b8'],
  terraform: ['fa-solid fa-road', '#7b42bc'], hcl: ['fa-solid fa-road', '#7b42bc'],
  tf: ['fa-solid fa-road', '#7b42bc'], tfvars: ['fa-solid fa-road', '#7b42bc'],
  k3s: ['fa-solid fa-cubes', '#8c93a8'], ymlc: ['fa-solid fa-gears', '#cb171e'],
  env: ['fa-solid fa-gear', '#8c93a8'], ini: ['fa-solid fa-gears', '#8c93a8'], cfg: ['fa-solid fa-gears', '#8c93a8'],
  conf: ['fa-solid fa-gears', '#8c93a8'],
  lua: ['fa-solid fa-code', '#000080'], r: ['fa-solid fa-code', '#226698'],
  scala: ['fa-solid fa-code', '#dc322f'], hs: ['fa-solid fa-code', '#8c93a8'],
  ex: ['fa-solid fa-droplet', '#6e4a7e'], exs: ['fa-solid fa-droplet', '#6e4a7e'],
  clj: ['fa-solid fa-leaf', '#8c93a8'], elm: ['fa-solid fa-leaf', '#60b5cc'],
  cob: ['fa-solid fa-code', '#5a9bd4'], pas: ['fa-solid fa-code', '#5a9bd4'],
  asm: ['fa-solid fa-microchip', '#8c93a8'], s: ['fa-solid fa-microchip', '#8c93a8'],
  diff: ['fa-solid fa-code-compare', '#b8c832'], patch: ['fa-solid fa-code-compare', '#b8c832'],
  exe: ['fa-solid fa-gears', '#8c93a8'], dll: ['fa-solid fa-gears', '#8c93a8'], so: ['fa-solid fa-gears', '#8c93a8'],
  jar: ['fa-solid fa-box-archive', '#e76f00'], war: ['fa-solid fa-box-archive', '#e76f00'],
  class: ['fa-solid fa-c', '#e76f00'], o: ['fa-solid fa-gears', '#8c93a8'], obj: ['fa-solid fa-gears', '#8c93a8'],
  csv: ['fa-solid fa-table', '#2e9e6b'], tsv: ['fa-solid fa-table', '#2e9e6b'], xls: ['fa-solid fa-file-excel', '#1d6f42'],
  xlsx: ['fa-solid fa-file-excel', '#1d6f42'], doc: ['fa-solid fa-file-word', '#185abd'],
  docx: ['fa-solid fa-file-word', '#185abd'], ppt: ['fa-solid fa-file-powerpoint', '#c43e1c'],
  pptx: ['fa-solid fa-file-powerpoint', '#c43e1c'],
  sol: ['fa-solid fa-file-code', '#e38c00'],
  npm: ['fa-brands fa-npm', '#cb3837'], node: ['fa-brands fa-node', '#339933'],
  elixir: ['fa-solid fa-droplet', '#6e4a7e'], erl: ['fa-solid fa-droplet', '#b83998'],
};
function fileIconOf(name, isDir = false, open = false) {
  if (isDir) return open ? ['fa-solid fa-folder-open', '#fbbf24'] : ['fa-solid fa-folder', '#fcd34d'];
  const base = name.split('.').pop().toLowerCase();
  const lname = name.toLowerCase();
  if (lname === 'dockerfile' || lname === 'containerfile') return ICONS.dockerfile;
  if (lname === 'makefile' || lname === 'gnumakefile') return ICONS.makefile;
  const key = base === 'gitignore' ? 'gitignore' : base;
  return ICONS[key] || ['fa-solid fa-file', '#8c93a8'];
}
/* Media kind helper: 'image' | 'video' | 'audio' | null */
function mediaKindOf(name) {
  const base = (name || '').split('.').pop().toLowerCase();
  if (/(png|jpg|jpeg|gif|svg|webp|avif|bmp|ico)/.test(base)) return 'image';
  if (/(mp4|m4v|mov|mkv|webm|ogv)/.test(base)) return 'video';
  if (/(mp3|wav|ogg|flac|m4a)/.test(base)) return 'audio';
  return null;
}

/* ---------------- Language mapping for Monaco ---------------- */
const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss', md: 'markdown', py: 'python', rb: 'ruby',
  go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', xml: 'xml', svg: 'xml', sql: 'sql',
  vue: 'html', svelte: 'html', lock: 'json', toml: 'ini', conf: 'ini', ini: 'ini', sqlite: 'sql', ps1: 'powershell',
  dart: 'dart', kt: 'kotlin', lua: 'lua', clj: 'clojure', ex: 'elixir', exs: 'elixir', fs: 'fsharp', hx: 'haxe',
  r: 'r', scala: 'scala', swift: 'swift', vb: 'vb', txt: 'plaintext', log: 'plaintext',
  m: 'objective-c', mm: 'objective-c', pl: 'perl', pm: 'perl', pas: 'pascal', tcl: 'tcl',
  lisp: 'lisp', cl: 'lisp', el: 'lisp', coffe: 'coffee', coffee: 'coffee',
  erl: 'erlang', hrl: 'erlang', groovy: 'groovy', gradle: 'groovy', sol: 'solidity', less: 'less',
  cshtml: 'razor', razor: 'razor', bat: 'bat', dockerfile: 'dockerfile', makefile: 'makefile', hcl: 'plaintext',
};
function langForPath(path) {
  const base = (path.split('/').pop() || '').toLowerCase();
  if (base === 'dockerfile' || base === 'containerfile') return 'dockerfile';
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile';
  return LANG[path.split('.').pop().toLowerCase()] || 'plaintext';
}

/* ---------------- Context menu helper ---------------- */
function useClickOutside(ref, onOutside) {
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onOutside(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onOutside]);
}

/* ---------------- Mobile detection ---------------- */
function useMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const h = (ev) => setIsMobile(ev.matches);
    setIsMobile(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [breakpoint]);
  return isMobile;
}

/* ============================================================
   MAIN APP
   ============================================================ */
function App() {
  const [booting, setBooting] = useState(true);
  const [monacoReady, setMonacoReady] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [tree, setTree] = useState(null);
  const [selected, setSelected] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [tabs, setTabs] = useState([]);       // [{path, name, dirty}]
  const [activePath, setActivePath] = useState(null);
  const isMobile = useMobile();
  const [sidebarOpen, setSidebarOpen] = useState(isMobile ? false : true);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [termOpen, setTermOpen] = useState(isMobile ? false : true);
  const [termHeight, setTermHeight] = useState(230);
  const [modals, setModals] = useState(null);         // {type, node, parent}
  const [ctxMenu, setCtxMenu] = useState(null);       // {x,y, items[], data}
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [wsStatus, setWsStatus] = useState('connecting');
  const [search, setSearch] = useState('');
  const [statusInfo, setStatusInfo] = useState({});
  const [filesList, setFilesList] = useState([]);
  const [sysStats, setSysStats] = useState(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [latency, setLatency] = useState(null);
  const latencyRef = useRef(0);
  const uploadRef = useRef(null);
  const pingSentAtRef = useRef(0);

  /* Auth */
  const [authed, setAuthed] = useState(() => !!localStorage.getItem('pc-token'));
  const authedRef = useRef(authed);
  authedRef.current = authed;

  /* Multiplayer */
  const [mpOpen, setMpOpen] = useState(false);
  const [mpReady, setMpReady] = useState(false);
  const [mpConfig, setMpConfig] = useState(null);
  const [frozenUi, setFrozenUi] = useState(false);
  const [approvalPending, setApprovalPending] = useState(false);
  const [inRoom, setInRoom] = useState(false);
  const [roomCount, setRoomCount] = useState(0);
  const [mediaPreview, setMediaPreview] = useState(null); // {path, kind, name} | null
  const [pendingJoin] = useState(() => {
    try { return new URLSearchParams(location.search).get('join') || ''; } catch (e) { return ''; }
  });

  /* Google Drive backup */
  const [drive, setDrive] = useState({ configured: false, connected: false, email: null });
  const [driveModal, setDriveModal] = useState(false);
  const driveRef = useRef(drive);
  driveRef.current = drive;
  const driveOkRef = useRef(true); // tracks whether the last sync attempt succeeded (to avoid toast spam)
  const inRoomRef = useRef(false);
  const myOidRef = useRef(null);
  const hostOidRef = useRef(null);
  const frozenRef = useRef(false);
  const activePathRef = useRef(null);
  const lastSentRef = useRef(new Map());
  const remoteCursorsRef = useRef(new Map());
  const cursorStylesRef = useRef(new Set());
  const mpOpTimerRef = useRef(null);
  const expectVersionRef = useRef(-1); // exact versionId of a remote edit we're applying
  const lastCursorSentRef = useRef({ at: 0, path: '', line: -1, col: -1 });

  const wsRef = useRef(null);
  const editorRef = useRef(null);
  const modelsRef = useRef(new Map());
  const contentRef = useRef(new Map());
  const isSavingRef = useRef(false);
  const fallbackGetRef = useRef(null);
  const registerGet = useCallback((fn) => { fallbackGetRef.current = fn; }, []);
  const fallbackApplyRef = useRef(null);
  const registerApply = useCallback((fn) => { fallbackApplyRef.current = fn; }, []);

  /* ---------- Monaco init (falls back to plain-text editor if it fails) ---------- */
  useEffect(() => {
    let cancelled = false;
    const start = Date.now();
    let fallbackShown = false;
    const tryLoad = () => {
      if (cancelled) return;
      if (window.monaco && window.monaco.editor) {
        defineTheme();
        setMonacoReady(true);
        // Heal: monaco finished loading late → switch the plain editor back to Monaco.
        setFallback(false);
        return;
      }
      if (!fallbackShown && Date.now() - start > 12000) {
        fallbackShown = true;
        // Let the user edit right away; monaco keeps loading in the background.
        setFallback(true);
      }
      if (window.require) {
        try {
          window.require.config({
            paths: { vs: '/vendor/monaco/vs' },
          });
          window.require(['vs/editor/editor.main'], () => {
            if (cancelled || !window.monaco || !window.monaco.editor) return;
            defineTheme();
            setMonacoReady(true);
            setFallback(false);
          });
        } catch (err) {
          console.error('monaco load error', err);
        }
        setTimeout(tryLoad, 1500);
      } else {
        setTimeout(tryLoad, 300);
      }
    };
    tryLoad();
    return () => { cancelled = true; };
  }, []);

  function defineTheme() {
    try {
      window.monaco.editor.defineTheme('nova-dark', {
        base: 'vs-dark', inherit: true,
        rules: [
          { token: 'comment', foreground: '5c6378', fontStyle: 'italic' },
          { token: 'keyword', foreground: 'c792ea' },
          { token: 'string', foreground: 'c3e88d' },
          { token: 'number', foreground: 'f78c6c' },
          { token: 'type', foreground: '82aaff' },
          { token: 'identifier.function', foreground: '82aaff' },
          { token: 'function', foreground: '82aaff' },
          { token: 'type.identifier', foreground: '82aaff' },
          { token: 'delimiter', foreground: '89ddff' },
          { token: 'tag', foreground: 'f07178' },
          { token: 'attribute.name', foreground: '82aaff' },
        ],
        colors: {
          'editor.background': '#0b0d13',
          'editor.foreground': '#e6e9f2',
          'editorLineNumber.foreground': '#2e3444',
          'editorLineNumber.activeForeground': '#8c93a8',
          'editorCursor.foreground': '#818cf8',
          'editor.selectionBackground': '#6366f133',
          'editor.inactiveSelectionBackground': '#6366f117',
          'editor.lineHighlightBackground': '#ffffff06',
          'editorIndentGuide.background': '#ffffff0c',
          'editorIndentGuide.activeBackground': '#ffffff18',
          'editorWidget.background': '#141822f2',
          'editorWidget.border': '#ffffff14',
          'scrollbarSlider.background': '#ffffff17',
          'scrollbarSlider.hoverBackground': '#ffffff2b',
          'editorBracketMatch.background': '#6366f144',
          'editorBracketMatch.border': '#6366f100',
        },
      });
    } catch (err) { console.error(err); }
  }

  /* ---------- WS + boot ---------- */
  useEffect(() => {
    if (!authed) return;
    let ws;
    let heartbeat;
    const connect = () => {
      setWsStatus('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const token = localStorage.getItem('pc-token') || '';
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        setWsStatus('online');
        heartbeat = setInterval(() => {
          if (ws.readyState === 1) {
            pingSentAtRef.current = Date.now();
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 5000);
      };
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.type === 'pong') {
          const l = Math.max(0, Date.now() - pingSentAtRef.current);
          latencyRef.current = l;
          setLatency(l);
          // Report our ping to the room so the players list shows live ms.
          if (inRoomRef.current) sendMp({ type: 'mp:ms', ms: l });
        }
        if (m.type === 'fs:refresh') {
          loadTree();
        }
        if (m.type === 'system') { setStatusInfo((p) => ({ ...p, system: m.system })); }
        if (m.type === 'system:stats') { setSysStats(m.stats); }
        if (m.type === 'mp:ready') { setMpReady(true); setMpConfig(m.config); }
        window.dispatchEvent(new CustomEvent('nova-ws', { detail: m }));
      };
      ws.onclose = (ev) => {
        setWsStatus('offline');
        clearInterval(heartbeat);
        wsRef.current = null;
        if (ev && ev.code === 4001) {
          localStorage.removeItem('pc-token');
          localStorage.removeItem('pc-user');
          setAuthed(false);
          return;
        }
        if (ev && (ev.code === 4002 || ev.code === 4003)) {
          // Kicked/denied: revoke local creds so no file access lingers.
          localStorage.removeItem('pc-token');
          localStorage.removeItem('pc-user');
          setAuthed(false);
          window.dispatchEvent(new CustomEvent('nova-ws', {
            detail: { type: 'mp:left', reason: ev.code === 4002 ? 'You were kicked from the room' : 'Join request denied by host', kicked: true },
          }));
          return;
        }
        if (ev && ev.code === 4004) {
          window.dispatchEvent(new CustomEvent('nova-ws', {
            detail: { type: 'mp:left', reason: 'The host ended the session', kicked: true },
          }));
        }
        if (authedRef.current) setTimeout(connect, 2500);
      };
      ws.onerror = () => {};
    };
    connect();
    return () => { clearInterval(heartbeat); try { ws && ws.close(); } catch (_) {} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  /* Logout handler (401 from api()) */
  useEffect(() => {
    const h = (e) => { if (e.detail && e.detail.logout) { setAuthed(false); } };
    window.addEventListener('nova-auth', h);
    return () => window.removeEventListener('nova-auth', h);
  }, []);

  async function loadTree() {
    try {
      const t = await api('GET', '/api/fs/tree');
      setTree(t);
      const files = [];
      const walk = (node, pfx = '') => {
        if (node.type === 'file') {
          const p = pfx ? pfx + '/' + node.name : node.name;
          files.push({ path: p, name: node.name });
        }
        if (node.children) node.children.forEach((c) => walk(c, pfx ? pfx + '/' + node.name : node.name));
      };
      for (const n of t) walk(n, '');
      setFilesList(files);
    } catch (e) { if (e.message && /pending/i.test(e.message)) setApprovalPending(true); else toast(e.message, 'error'); }
  }

  const setSystem = (s) => setStatusInfo((p) => ({ ...p, system: s }));

  useEffect(() => {
    if (!authed) return;
    (async () => {
      try { const sys = await api('GET', '/api/system'); setStatusInfo((p) => ({ ...p, sys })); } catch (_) {}
      api('GET', '/api/gdrive/status')
        .then((d) => setDrive({ configured: !!d.configured, connected: !!d.connected, email: d.email || null }))
        .catch(() => {});
      await loadTree();
      setBooting(false);
    })();
  }, [authed]);

  /* Keep activePath in a ref for the collab layer */
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);

  /* ---------- Multiplayer: collab relay + remote cursors + freeze ---------- */
  useEffect(() => {
    const handler = (e) => {
      const m = e.detail;
      if (!m) return;

      if (m.type === 'mp:joined') {
        inRoomRef.current = true;
        myOidRef.current = m.myOid;
        setInRoom(true);
        setRoomCount((m.players || []).length);
        setApprovalPending(false);
        loadTree();
      } else if (m.type === 'mp:players') {
        setRoomCount((m.players || []).length);
      } else if (m.type === 'mp:pending') {
        inRoomRef.current = true;
        setInRoom(true);
        setApprovalPending(true);
      } else if (m.type === 'mp:left' || m.type === 'mp:closed') {
        inRoomRef.current = false;
        myOidRef.current = null;
        hostOidRef.current = null;
        frozenRef.current = false;
        setFrozenUi(false);
        setApprovalPending(false);
        const ed = editorRef.current;
        if (ed) { try { ed.updateOptions({ readOnly: false }); } catch (_) {} }
        setInRoom(false);
        setRoomCount(0);
        clearRemoteCursors();
        if (m.reason) toast(m.reason, 'info');
        if (m.type === 'mp:closed') toast('Chat & voice session closed', 'info');
        loadTree(); // back to your own folder when you leave a room
      } else if (m.type === 'mp:frozen' && m.you) {
        frozenRef.current = !!m.frozen;
        setFrozenUi(!!m.frozen);
        const ed = editorRef.current;
        if (ed) { try { ed.updateOptions({ readOnly: !!m.frozen }); } catch (_) {} }
        if (!m.frozen) toast('You are unfrozen', 'success');
        else toast('You have been frozen by the host', 'info');
      }

      if (m.type === 'mp:joined') {
        const host = (m.players || []).find((p) => p.isHost);
        hostOidRef.current = host ? host.oid : null;
      }
      if (m.type === 'mp:players') {
        const host = (m.players || []).find((p) => p.isHost);
        hostOidRef.current = host ? host.oid : null;
      }
      if (m.type === 'mp:cursor') {
        setRemoteCursor(m.from, m.path, m.line, m.col, m.name, m.color);
      }
      if (m.type === 'mp:op') {
        applyRemoteOps(m.from, m.path, m.edits);
      }
      if (m.type === 'mp:reqsync') {
        if (String(m.to) === String(myOidRef.current) && String(m.from) !== String(myOidRef.current)) {
          const text = acquireContent(m.path);
          if (text != null) wsSendT(wsRef, { type: 'mp:sync', to: m.from, path: m.path, text });
        }
      }
      if (m.type === 'mp:sync') {
        if (String(m.to) === String(myOidRef.current) && String(m.from) !== String(myOidRef.current)) {
          applyRemoteText(m.path, m.text);
        }
      }
    };
    window.addEventListener('nova-ws', handler);
    return () => window.removeEventListener('nova-ws', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Auto-open the panel and join when arriving via an invite link */
  useEffect(() => {
    if (!(authed && !booting && mpReady) || !pendingJoin) return;
    setMpOpen(true);
    const t = setTimeout(() => {
      if (inRoomRef.current) return;
      wsSendT(wsRef, { type: 'mp:join', roomId: String(pendingJoin).toUpperCase() });
    }, 700);
    return () => clearTimeout(t);
  }, [authed, booting, mpReady, pendingJoin]);

  /* ---------- MP utility fns ---------- */
  function sendMp(obj) {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function lineDiff(prev, next) {
    const a = String(prev || '').split('\n');
    const b = String(next || '').split('\n');
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const aEnd = a.length - suf;
    const bEnd = b.length - suf;
    if (pre >= aEnd && pre >= bEnd) return [];
    const inserted = b.slice(pre, bEnd);
    let text;
    if (pre === aEnd && aEnd === a.length) {
      const sep = a.length && a[a.length - 1] === '' ? '' : '\n';
      text = sep + inserted.join('\n');
      if (bEnd < b.length) text += '\n';
    } else {
      text = inserted.join('\n') + (bEnd < b.length && inserted.length ? '\n' : '');
    }
    return [{
      range: { startLineNumber: pre + 1, startColumn: 1, endLineNumber: aEnd + 1, endColumn: 1 },
      text,
    }];
  }

  function makeEdits(prev, next) {
    if (String(prev || '') === String(next || '')) return [];
    const eds = lineDiff(prev, next);
    try {
      if (eds.length && applyEditsToText(prev, eds) === String(next || '')) return eds;
    } catch (_) {}
    const a = String(prev || '').split('\n').length;
    return [{
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: a + 1, endColumn: 1 },
      text: String(next || ''),
    }];
  }

  /* Relay local edits to the room. When Monaco gives us the real per-keystroke
     change descriptors we relay them immediately (true real-time); the plain-text
     fallback has no change events so it falls back to a short content diff. */
  function scheduleOpRelay(path, changes) {
    if (!inRoomRef.current || frozenRef.current) return;
    if (changes && changes.length) {
      const model = modelsRef.current.get(path);
      const edits = changes.map((c) => ({
        range: {
          startLineNumber: c.range.startLineNumber, startColumn: c.range.startColumn,
          endLineNumber: c.range.endLineNumber, endColumn: c.range.endColumn,
        },
        text: c.text || '',
      }));
      if (model) lastSentRef.current.set(path, model.getValue());
      sendMp({ type: 'mp:op', path, edits });
      return;
    }
    clearTimeout(mpOpTimerRef.current);
    mpOpTimerRef.current = setTimeout(() => {
      let content;
      const model = modelsRef.current.get(path);
      if (model) content = model.getValue();
      else if (fallback && fallbackGetRef.current) content = fallbackGetRef.current();
      if (content == null) return;
      const last = lastSentRef.current.get(path);
      if (last === content) return;
      const edits = makeEdits(last, content);
      lastSentRef.current.set(path, content);
      if (edits.length) sendMp({ type: 'mp:op', path, edits });
    }, 90);
  }

  function applyRemoteOps(from, path, edits) {
    if (!from || String(from) === String(myOidRef.current)) return;
    if (!edits || !edits.length) return;
    const model = modelsRef.current.get(path);
    if (model) {
      // Version-matched suppression: only the exact content-changed event our
      // push produces gets skipped, so a missed event can never swallow the
      // user's own typing (the earlier flag approach could get stuck).
      expectVersionRef.current = model.getVersionId() + 1;
      try {
        model.pushEditOperations(null, edits.map((ed) => ({
          range: new window.monaco.Range(
            ed.range.startLineNumber, ed.range.startColumn,
            ed.range.endLineNumber, ed.range.endColumn
          ),
          text: ed.text || '',
          forceMoveMarkers: true,
        })), () => null);
        lastSentRef.current.set(path, model.getValue());
      } catch (_) {
        expectVersionRef.current = -1;
        // Baseline mismatch (our copy is stale) → ask the author for the real text.
        wsSendT(wsRef, { type: 'mp:reqsync', to: from, path });
      }
    } else if (fallbackApplyRef.current && activePathRef.current === path) {
      const next = fallbackApplyRef.current(edits);
      lastSentRef.current.set(path, next || '');
    }
  }

  /* Current committed-across-peers text for a path (null if we don't hold it). */
  function acquireContent(path) {
    const model = modelsRef.current.get(path);
    if (model) return model.getValue();
    if (fallback && activePathRef.current === path && fallbackGetRef.current) return fallbackGetRef.current();
    return null;
  }

  /* Replace local content for a path with a peer's authoritative text. */
  function applyRemoteText(path, text) {
    const value = String(text == null ? '' : text);
    const model = modelsRef.current.get(path);
    if (model) {
      let changed = false;
      if (model.getValue() !== value) {
        changed = true;
        expectVersionRef.current = model.getVersionId() + 1;
        try { model.setValue(value); } catch (_) {}
      }
      lastSentRef.current.set(path, value);
      if (changed) {
        contentRef.current.set(path, value);
        markDirty(path);
        placeAllRemoteCursors();
      }
    } else if (fallbackApplyRef.current && activePathRef.current === path) {
      fallbackApplyRef.current(value);
      lastSentRef.current.set(path, value);
      contentRef.current.set(path, value);
      markDirty(path);
    }
  }

  function announceCursor(path) {
    if (!inRoomRef.current || !window.monaco) return;
    sendMp({ type: 'mp:cursor', path, line: 1, col: 1 });
  }

  function ensureCursorStyle(oid, name, color) {
    if (cursorStylesRef.current.has(oid)) return;
    cursorStylesRef.current.add(oid);
    try {
      const st = document.createElement('style');
      st.id = 'mp-cursor-' + oid;
      const safe = String(name).replace(/["\\]/g, '').replace(/\s+/g, ' ');
      st.textContent =
        `.mpc-${oid} { border-left: 2px solid ${color} !important; }` +
        `.mpc-label-${oid}::before { content: "${safe}"; background: ${color}; color:#0a0c10; font-size:11px; line-height:15px; padding:0 5px; border-radius:3px; font-weight:600; white-space:nowrap; max-width:140px; overflow:hidden; text-overflow:ellipsis; letter-spacing:.02em; }` +
        `@media (max-width:768px){ .mpc-label-${oid}::before { font-size:8.5px; line-height:12px; padding:0 3px; max-width:72px; } }`;
      document.head.appendChild(st);
    } catch (_) {}
  }

  function setRemoteCursor(oid, path, line, col, name, color) {
    ensureCursorStyle(oid, name, color);
    const prev = remoteCursorsRef.current.get(oid);
    if (prev && prev.coll) { try { prev.coll.clear(); } catch (_) {} }
    remoteCursorsRef.current.set(oid, { oid, path, line, col, name, color, coll: null, lastSeen: Date.now() });
    placeRemoteCursor(oid);
  }

  function placeRemoteCursor(oid) {
    const ed = editorRef.current;
    const curs = remoteCursorsRef.current.get(oid);
    if (!curs || !ed || !window.monaco) return;
    if (curs.coll) { try { curs.coll.clear(); } catch (_) {} curs.coll = null; }
    if (curs.path !== activePathRef.current) return;
    const model = ed.getModel();
    if (!model) return;
    const line = Math.max(1, Math.min(curs.line || 1, model.getLineCount()));
    const col = Math.max(1, Math.min(curs.col || 1, model.getLineMaxColumn(line)));
    try {
      curs.coll = window.monaco.editor.createDecorationsCollection(ed, [
        {
          range: new window.monaco.Range(line, col, line, col),
          options: {
            linesDecorationsClassName: `mpc-${oid}`,
            beforeContentClassName: `mpc-label-${oid}`,
          },
        },
      ]);
    } catch (_) {}
  }

  function clearRemoteCursors() {
    remoteCursorsRef.current.forEach((c) => { if (c.coll) { try { c.coll.clear(); } catch (_) {} } });
    remoteCursorsRef.current.clear();
  }

  function placeAllRemoteCursors() {
    remoteCursorsRef.current.forEach((c) => placeRemoteCursor(c.oid));
  }

  function clearRemoteCursorsForPath(path) {
    remoteCursorsRef.current.forEach((c) => {
      if (c.path === path && c.coll) { try { c.coll.clear(); } catch (_) {} c.coll = null; }
    });
  }

  /* ---------- Editor creation (once Monaco ready) ---------- */
  useEffect(() => {
    if (!monacoReady || !document.getElementById('monaco-host') || editorRef.current) return;
    let ed;
    try {
      ed = window.monaco.editor.create(document.getElementById('monaco-host'), {
      theme: 'nova-dark',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: isMobile ? 16 : 13.5,
      fontLigatures: true,
      minimap: { enabled: false },
      automaticLayout: true,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      scrollBeyondLastLine: false,
      padding: { top: 10 },
      tabSize: 2,
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
      fixedOverflowWidgets: true,
      wordWrap: isMobile ? 'on' : 'off',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      suggest: { shareSuggestSelections: true, showWords: true },
      quickSuggestions: true,
    });
    } catch (e) { console.error('monaco editor create error', e); }
    if (!ed) return;
    ed.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyP, () => setPaletteOpen(true));
    ed.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyK, () => setPaletteOpen(true));
    ed.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS, () => saveActive());
    ed.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyB, () => setSidebarOpen((v) => !v));
    ed.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.Backquote, () => setTermOpen((v) => !v));
    ed.onDidChangeCursorPosition((e) => {
      setStatusInfo((p) => ({ ...p, pos: `Ln ${e.position.lineNumber}, Col ${e.position.column}` }));
      const model = ed.getModel();
      let p = null;
      if (model && model.uri && model.uri.path) p = decodeURIComponent(model.uri.path.slice(1));
      if (!p || !inRoomRef.current) return;
      const now = Date.now();
      const last = lastCursorSentRef.current;
      if (now - last.at > 150 && (last.path !== p || last.line !== e.position.lineNumber || last.col !== e.position.column)) {
        lastCursorSentRef.current = { at: now, path: p, line: e.position.lineNumber, col: e.position.column };
        sendMp({ type: 'mp:cursor', path: p, line: e.position.lineNumber, col: e.position.column });
      }
    });
    ed.onDidChangeModelContent((e) => {
      const model = ed.getModel();
      if (!model) return;
      const p = model.uri && model.uri.path ? decodeURIComponent(model.uri.path.slice(1)) : null;
      if (!p) return;
      if (expectVersionRef.current > -1 && e && e.versionId === expectVersionRef.current) {
        expectVersionRef.current = -1;
        return; // this is the remote edit we just applied – don't re-relay
      }
      if (!isSavingRef.current) markDirty(p);
      scheduleOpRelay(p, (e && e.changes) || null);
    });
    editorRef.current = ed;
    // Heal: a file may already be open (opened before this editor existed / while
    // the plain-text fallback was shown). Port it into Monaco immediately.
    const p = activePath;
    if (p && !modelsRef.current.has(p)) {
      const existing = contentRef.current.get(p);
      if (existing != null) {
        const uri = window.monaco.Uri.file(p);
        const model = window.monaco.editor.createModel(existing, langForPath(p), uri);
        modelsRef.current.set(p, model);
        if (editorRef.current) editorRef.current.setModel(model);
        placeAllRemoteCursors();
        announceCursor(p);
      } else {
        loadIntoEditor(p);
      }
    }
  }, [monacoReady, isMobile, fallback, authed]);
  /* Automatically back up a write/create/rename/delete to the user's Google
     Drive when connected. Never blocks or fails the local operation. */
  const syncToDrive = useCallback(async (action, path, extra = {}) => {
    const d = driveRef.current;
    if (!d || !d.connected) return;
    try {
      await api('POST', '/api/gdrive/sync', { action, path, ...extra });
      if (!driveOkRef.current) { driveOkRef.current = true; toast('Google Drive sync resumed', 'success'); }
    } catch (e) {
      if (driveOkRef.current) { driveOkRef.current = false; toast(`Google Drive sync failed: ${e.message}`, 'error'); }
    }
  }, []);

  const saveActive = useCallback(async () => {
    const ed = editorRef.current;
    if (!activePath) return;
    const content = fallback
      ? (fallbackGetRef.current ? fallbackGetRef.current() : '')
      : (ed ? ed.getValue() : '');
    isSavingRef.current = true;
    try {
      await api('POST', '/api/fs/write', { path: activePath, content });
      contentRef.current.set(activePath, content);
      setTabs((ts) => ts.map((t) => (t.path === activePath ? { ...t, dirty: false } : t)));
      toast(`Saved ${activePath}`, 'success');
      syncToDrive('write', activePath, { content });
    } catch (e) { toast(`Save failed: ${e.message}`, 'error'); }
    finally { isSavingRef.current = false; }
  }, [activePath, fallback]);

  /* ---------- Tab management ---------- */
  function selectTab(path) {
    setActivePath(path);
    loadIntoEditor(path);
  }

  async function openFile(path, name) {
    if (!tabs.some((t) => t.path === path)) {
      setTabs((ts) => [...ts, { path, name, dirty: false }]);
    }
    setActivePath(path);
    loadIntoEditor(path);
  }

  async function loadIntoEditor(path) {
    let loadTimer = null;
    if (modelsRef.current.has(path)) {
      const ed = editorRef.current;
      if (ed) ed.setModel(modelsRef.current.get(path));
      placeAllRemoteCursors();
      return;
    }
    setStatusInfo((p) => ({ ...p, loading: path }));
    try {
      // Never leave the loading state hanging forever.
      loadTimer = setTimeout(() => { setStatusInfo((p) => ({ ...p, loading: null })); }, 12000);
      const r = await Promise.race([
        api('GET', `/api/fs/read?path=${encodeURIComponent(path)}`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out opening file')), 10000)),
      ]);
      clearTimeout(loadTimer);
      if (r.binary) {
        const kind = mediaKindOf(path);
        if (kind) {
          setMediaPreview({ path, kind, name: path.split('/').pop() });
          contentRef.current.set(path, '');
          setStatusInfo((p) => ({ ...p, loading: null }));
          return;
        }
        toast('Binary file – use the download option', 'info');
        setActivePath(null);
        setTabs((ts) => ts.filter((t) => t.path !== path));
        return;
      }
      contentRef.current.set(path, r.content || '');
      lastSentRef.current.set(path, r.content || '');
      // If Monaco isn't ready yet, still show the file immediately in the
      // plain-text editor (never a blank area when tapping a file).
      if (!window.monaco || !window.monaco.editor || !monacoReady) {
        // Monaco isn't usable in this moment → plain-text fallback.
        setFallback(true);
        setStatusInfo((p) => ({ ...p, loading: null }));
        return;
      }
      const uri = window.monaco.Uri.file(path);
      const model = window.monaco.editor.createModel(r.content || '', langForPath(path), uri);
      modelsRef.current.set(path, model);
      if (editorRef.current) editorRef.current.setModel(model);
      placeAllRemoteCursors();
      announceCursor(path);
      // A peer may be editing this file right now. Prefer the peer who most
      // recently had a cursor here (they hold the current text); fall back to
      // the host as room authority.
      if (inRoomRef.current) {
        const me = String(myOidRef.current);
        const viewer = [...remoteCursorsRef.current.entries()]
          .filter(([oid, c]) => c.path === path && String(oid) !== me)
          .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
          .map(([oid]) => oid);
        const source = viewer[0] || hostOidRef.current;
        if (source && String(source) !== me) {
          wsSendT(wsRef, { type: 'mp:reqsync', to: source, path });
        }
      }
    } catch (e) {
      toast(`Could not open ${path}: ${e.message}`, 'error');
      setActivePath(null);
      setTabs((ts) => ts.filter((t) => t.path !== path));
    } finally { setStatusInfo((p) => ({ ...p, loading: null })); }
  }

  function markDirty(path) {
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, dirty: true } : t)));
  }

  function closeTab(path) {
    const idx = tabs.findIndex((t) => t.path === path);
    const next = tabs.filter((t) => t.path !== path);
    setTabs(next);
    modelsRef.current.get(path)?.dispose();
    modelsRef.current.delete(path);
    contentRef.current.delete(path);
    lastSentRef.current.delete(path);
    if (mediaPreview && mediaPreview.path === path) setMediaPreview(null);
    clearRemoteCursorsForPath(path);
    if (activePath === path) {
      const after = next[idx] || next[idx - 1];
      setActivePath(after ? after.path : null);
      if (after) loadIntoEditor(after.path);
    }
  }

  function closeAll() {
    modelsRef.current.forEach((m) => m.dispose());
    modelsRef.current.clear();
    if (editorRef.current) editorRef.current.setModel(null);
    setTabs([]);
    setActivePath(null);
    setMediaPreview(null);
    clearRemoteCursors();
    lastSentRef.current.clear();
  }

  /* ---------- FS operations ---------- */
  async function createEntry(parentPath, name, type) {
    const p = parentPath ? `${parentPath}/${name}` : name;
    try {
      await api('POST', '/api/fs/create', { path: p, type });
      await loadTree();
      setModals(null);
      if (type === 'file') {
        openFile(p, name);
        syncToDrive('write', p, { content: '' });
      }
      toast(`${type === 'directory' ? 'Folder' : 'File'} created`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function renameEntry(node, newName) {
    try {
      await api('POST', '/api/fs/rename', { path: node.path, newName });
      const slash = node.path.lastIndexOf('/');
      const newPath = slash >= 0 ? node.path.slice(0, slash) + '/' + newName : newName;
      syncToDrive('rename', node.path, { newPath });
      setModals(null);
      toast('Renamed', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteEntry(node) {
    try {
      await api('POST', '/api/fs/delete', { path: node.path });
      syncToDrive('delete', node.path);
      if (node.type === 'file') {
        const fp = node.path;
        closeTab(fp);
      }
      setModals(null);
      setCtxMenu(null);
      toast(`${node.type === 'directory' ? 'Folder' : 'File'} deleted`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---------- Upload files (with progress) ---------- */
  function uploadFiles(files, dir) {
    Array.from(files).forEach((f) => {
      const id = Date.now() + Math.random();
      setUploads((u) => [...u, { id, name: f.name, pct: 0 }]);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/fs/upload?path=${encodeURIComponent(dir || '')}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(f.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          setUploads((xs) => xs.map((x) => (x.id === id ? { ...x, pct } : x)));
        }
      };
      xhr.onload = () => {
        let done = { pct: 100, done: true };
        if (xhr.status !== 200) {
          let msg = 'Upload failed';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
          done = { ...done, error: msg };
        } else {
          // Text files keep a Google Drive backup in sync; binaries are skipped.
          if (/\.(txt|md|mdx|js|jsx|ts|tsx|json|html|htm|css|scss|sass|less|py|rb|go|rs|java|c|h|cpp|cc|hpp|cs|php|sh|bash|zsh|yml|yaml|xml|svg|sql|toml|ini|conf|env|gitignore|pc|log|lock)$/i.test(f.name)) {
            const up = dir ? `${dir}/${f.name}` : f.name;
            syncToDrive('write', up);
          }
        }
        setUploads((xs) => xs.map((x) => (x.id === id ? { ...x, ...done } : x)));
        setTabs((ts) => ts.map((t) => (t.path === (dir ? dir + '/' + f.name : f.name) ? { ...t, dirty: false } : t)));
        loadTree();
        setTimeout(() => setUploads((xs) => xs.filter((x) => x.id !== id)), 2600);
      };
      xhr.onerror = () => {
        setUploads((xs) => xs.map((x) => (x.id === id ? { ...x, error: 'Network error', done: true } : x)));
        setTimeout(() => setUploads((xs) => xs.filter((x) => x.id !== id)), 2600);
      };
      xhr.send(f);
    });
  }

  function startUpload(dir) {
    if (!uploadRef.current) return;
    uploadRef.current.dataset.dir = dir || '';
    uploadRef.current.value = '';
    toast('Select files to upload', 'info');
    uploadRef.current.click();
  }

  function onPickFiles(e) {
    const files = e.target.files || [];
    const dir = e.target.dataset.dir || '';
    if (files.length) uploadFiles(files, dir);
    e.target.value = '';
  }

  /* ---------- Context menu ---------- */
  function openCtx(e, items, data) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, items, data });
  }

  function toggleExpand(path) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
  }

  const toggleTerm = () => setTermOpen((v) => !v);

  /* ---------- global keys ---------- */
  useEffect(() => {
    const h = (e) => {
      const m = e.ctrlKey || e.metaKey;
      if ((m && e.key === 'k') || (m && e.key === 'p')) { e.preventDefault(); setPaletteOpen(true); }
      if (m && e.key === '`') { e.preventDefault(); toggleTerm(); }
      if (m && e.key === 'j') { e.preventDefault(); toggleTerm(); }
      if (m && e.key === 'b') { e.preventDefault(); setSidebarOpen((v) => !v); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  /* ---------- render tree component ---------- */
  const renderTree = useCallback((nodes, depth) => {
    const ctxItems = (node) => ([
      { label: 'New File', icon: 'fa-file', fn: () => setModals({ type: 'create', parent: node.path || '', kind: 'file' }) },
      { label: 'New Folder', icon: 'fa-folder', fn: () => setModals({ type: 'create', parent: node.path || '', kind: 'directory' }) },
      ...(node.type === 'directory' ? [{ label: 'Upload here', icon: 'fa-upload', fn: () => startUpload(node.path || '') }] : []),
      ...(node.type === 'file' ? [
        { sep: true },
        { label: 'Download', icon: 'fa-download', fn: () => {
          const a = document.createElement('a');
          a.href = '/api/fs/download?path=' + encodeURIComponent(node.path);
          a.download = node.name;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => a.remove(), 0);
        } },
      ] : []),
      { label: 'Rename', icon: 'fa-pen', fn: () => setModals({ type: 'rename', node }) },
      { label: 'Delete', icon: 'fa-trash', fn: () => setModals({ type: 'confirmDel', node }), danger: true },
    ]);
    const openMore = (e, node) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openCtx({
        preventDefault() {},
        stopPropagation() {},
        clientX: Math.min(r.left, window.innerWidth - 230),
        clientY: r.bottom + 4,
      }, ctxItems(node), node);
    };
    return nodes.map((node) => {
      const isExpanded = expanded.has(node.path || node.name);
      const isSelected = selected === (node.path || node.name);
      const icon = fileIconOf(node.name, node.type === 'directory', isExpanded);
      const children = [];
      if (node.type === 'directory' && isExpanded && node.children) {
        children.push(renderTree(node.children, depth + 1));
      }
      return (
        <div key={node.path || node.name}>
          <div
            className={`tree-row ${isSelected ? 'selected' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              setSelected(node.path || node.name);
              if (node.type === 'directory') toggleExpand(node.path || '');
              else { openFile(node.path, node.name); if (isMobile) setSidebarOpen(false); }
            }}
            onDoubleClick={() => {
              if (node.type === 'file') loadIntoEditor(node.path);
            }}
            onContextMenu={(e) => openCtx(e, ctxItems(node), node)}
          >
            <span className={`twisty ${node.type === 'file' ? 'placeholder' : isExpanded ? 'open' : ''}`}>
              {node.type === 'directory' && <i className="fas fa-chevron-right" />}
            </span>
            <i className={`file-icon ${icon[0]}`} style={{ color: icon[1] }} />
            <span className="node-label">{node.name}</span>
            <span className="row-actions">
              {node.type === 'directory' && (
                <button className="icon-btn" title="New file" onClick={(e) => { e.stopPropagation(); setModals({ type: 'create', parent: node.path || '', kind: 'file' }); }}>
                  <i className="fas fa-plus" />
                </button>
              )}
              <button className="icon-btn" title="More" onClick={(e) => openMore(e, node)}>
                <i className="fas fa-ellipsis" />
              </button>
              <button className="icon-btn" title="Delete" onClick={(e) => { e.stopPropagation(); setModals({ type: 'confirmDel', node }); }}>
                <i className="fas fa-trash" />
              </button>
            </span>
          </div>
          {children}
        </div>
      );
    });
  }, [expanded, selected, isMobile]);

  const filteredTree = useMemo(() => {
    if (!search.trim()) return tree;
    const q = search.toLowerCase();
    const walk = (nodes, pfx = '') => {
      const out = [];
      for (const n of nodes) {
        const p = pfx ? pfx + '/' + n.name : n.name;
        if (n.type === 'directory') {
          const sub = n.children ? walk(n.children, p) : [];
          if (sub.length) out.push({ ...n, children: sub });
        } else if (p.toLowerCase().includes(q)) out.push(n);
      }
      return out;
    };
    return tree ? walk(tree) : tree;
  }, [tree, search]);

  const treeNodeCount = useMemo(() => {
    let c = 0;
    const walk = (nodes) => { for (const n of nodes) { c++; if (n.children) walk(n.children); } };
    if (tree) walk(tree);
    return c;
  }, [tree]);

  /* ---------- Resize logic ---------- */
  function startSidebarDrag(e) {
    e.preventDefault();
    setSidebarResizing(true);
    const move = (ev) => setSidebarWidth(Math.min(420, Math.max(180, ev.clientX)));
    const up = () => { setSidebarResizing(false); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  const termResizing = useRef(false);
  function startTermDrag(e) {
    e.preventDefault();
    termResizing.current = true;
    const move = (ev) => {
      const h = window.innerHeight - ev.clientY - 26;
      setTermHeight(Math.min(600, Math.max(120, h)));
    };
    const up = () => { termResizing.current = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /* ---------- active tab ---------- */
  const activeTab = useMemo(() => tabs.find((t) => t.path === activePath), [tabs, activePath]);

  return (
    <div className="ide-root">
      {!authed && (
        <Fragment>
          <LoginScreen onAuthed={(d) => { setAuthed(true); setMpReady(true); setMpConfig((c) => c || { enabled: true }); }} pendingJoin={pendingJoin} />
          <ToastRoot />
        </Fragment>
      )}
      {authed && booting && (
        <div className="splash">
          <div className="splash-logo">P</div>
          <div className="splash-title">Project CUI</div>
          <div className="spinner" />
        </div>
      )}
      {authed && !booting && (
        <Fragment>
          <TopBar
            wsStatus={wsStatus}
            onRun={() => setTermOpen(true)}
            onPalette={() => setPaletteOpen(true)}
            onSidebar={() => setSidebarOpen((v) => !v)}
            onTerm={toggleTerm}
            termOpen={termOpen}
            onUpload={() => startUpload('')}
            onSave={saveActive}
            canSave={!!activePath}
            mpReady={mpReady}
            inRoom={inRoom}
            roomCount={roomCount}
            onPeople={() => setMpOpen(true)}
            driveConnected={drive.connected}
            onDrive={() => setDriveModal(true)}
          />
          {isMobile && sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
          <div className="main-layout">
            <ActivityBar
              sidebarOpen={sidebarOpen}
              setSidebarOpen={setSidebarOpen}
              onPalette={() => setPaletteOpen(true)}
              termOpen={termOpen}
              onTerm={toggleTerm}
              onStats={() => setStatsOpen(true)}
              onPeople={() => setMpOpen(true)}
              mpReady={mpReady}
              inRoom={inRoom}
              roomCount={roomCount}
              driveConnected={drive.connected}
              onDrive={() => setDriveModal(true)}
            />
            <div className={`sidebar ${sidebarOpen ? '' : 'collapsed'} ${sidebarResizing ? 'resizing' : ''}`} style={{ width: sidebarOpen ? sidebarWidth : 0 }} onContextMenu={(e) => {
              const p = e.target.closest('.tree-row'); if (p) return;
              e.preventDefault();
              openCtx(e, [
                { label: 'New File', icon: 'fa-file', fn: () => setModals({ type: 'create', parent: '', kind: 'file' }) },
                { label: 'New Folder', icon: 'fa-folder', fn: () => setModals({ type: 'create', parent: '', kind: 'directory' }) },
                { label: 'Upload here', icon: 'fa-upload', fn: () => startUpload('') },
              ]);
            }}>
              {sidebarOpen && (
                <div className="sidebar-inner">
                  <div className="sidebar-header">
                    <span><i className="fa-solid fa-folder-tree" style={{ marginRight: 6 }} /> Explorer</span>
                    <div className="sidebar-header-actions">
                      <button className="icon-btn" title="New file" onClick={() => setModals({ type: 'create', parent: '', kind: 'file' })}><i className="fas fa-file" /></button>
                      <button className="icon-btn" title="New folder" onClick={() => setModals({ type: 'create', parent: '', kind: 'directory' })}><i className="fas fa-folder-plus" /></button>
                      <button className="icon-btn" title="Upload files" onClick={() => startUpload('')}><i className="fas fa-upload" /></button>
                      <button className="icon-btn" title="Refresh" onClick={loadTree}><i className="fas fa-rotate" /></button>
                    </div>
                  </div>
                  <div className="search-box">
                    <i className="fas fa-magnifying-glass" />
                    <input placeholder="Search files…" value={search} onChange={(e) => setSearch(e.target.value)} />
                  </div>
                  <div className="file-tree">
                    {filteredTree && filteredTree.length > 0 ? renderTree(filteredTree, 0) : (
                      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-faint)' }}>
                        {search ? 'No matches' : 'Empty workspace'}
                      </div>
                    )}
                    {!search && tree && (
                      <div style={{ padding: '14px 10px', color: 'var(--text-faint)', fontSize: 11 }}>
                        {treeNodeCount} items
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <ResizeHandle className="resize-handle" onMouseDown={startSidebarDrag} />

            <div className="editor-area">
              <TabsBar
                tabs={tabs}
                activePath={activePath}
                onSelect={selectTab}
                onClose={closeTab}
                onCloseAll={closeAll}
                onNewFile={() => setModals({ type: 'create', parent: '', kind: 'file' })}
              />
              <div className="editor-shell">
                <div id="monaco-host" className="editor-container" />
                {mediaPreview && mediaPreview.path === activePath && !fallback && (
                  <MediaPreview path={mediaPreview.path} kind={mediaPreview.kind} name={mediaPreview.name} />
                )}
                {fallback && activePath && (
                  <FallbackEditor
                    path={activePath}
                    initial={contentRef.current.get(activePath) || ''}
                    registerGet={registerGet}
                    registerApply={registerApply}
                    onDirty={markDirty}
                    onRelay={() => scheduleOpRelay(activePath)}
                  />
                )}
                {statusInfo.loading && (
                  <div className="editor-loading">
                    <div className="editor-loading-box">
                      <div className="spinner editor-loading-spin" />
                      <div className="editor-loading-path">{statusInfo.loading.split('/').pop()}</div>
                      <div className="editor-loading-sub">Opening file…</div>
                    </div>
                  </div>
                )}
                {!activePath && (
                    <div className="editor-empty">
                    <div className="big-logo">P</div>
                    <div className="empty-title">Welcome to Project CUI</div>
                    <div className="empty-sub">
                      Your self-hosted development workspace. Open a file from the explorer, or create something new to get started.
                    </div>
                    <div className="empty-actions">
                      <button className="empty-action primary" onClick={() => setModals({ type: 'create', parent: '', kind: 'file' })}>
                        <i className="fas fa-file" style={{ marginRight: 6 }} /> New file
                      </button>
                      <button className="empty-action" onClick={() => setModals({ type: 'create', parent: '', kind: 'directory' })}>
                        <i className="fas fa-folder-plus" style={{ marginRight: 6 }} /> New folder
                      </button>
                      <button className="empty-action" onClick={() => toast('Tip: press Ctrl+` to toggle terminal', 'info')}>
                        <i className="fas fa-terminal" style={{ marginRight: 6 }} /> Terminal
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {isMobile ? (
            <div className="term-fullscreen" style={termOpen ? undefined : { display: 'none' }}>
              <div className="term-fs-bar">
                <span className="term-fs-title"><i className="fa-solid fa-terminal" style={{ color: 'var(--accent-3)' }} /> Project CUI Terminal</span>
                <button className="icon-btn" onClick={() => setTermOpen(false)} title="Close terminal"><i className="fas fa-chevron-down" /></button>
              </div>
              <BottomPanel height="100%" startDrag={() => {}} onClose={() => setTermOpen(false)} wsRef={wsRef} />
            </div>
          ) : (
            <BottomPanel
              height={termOpen ? termHeight : 0}
              closed={!termOpen}
              startDrag={startTermDrag}
              onClose={() => setTermOpen(false)}
              wsRef={wsRef}
            />
          )}

          <StatusBar
            statusInfo={statusInfo}
            activeTab={activeTab}
            wsStatus={wsStatus}
            termOpen={termOpen}
            onTerm={toggleTerm}
          />

          <MobileNav
            sidebarOpen={sidebarOpen}
            onSidebar={() => setSidebarOpen((v) => !v)}
            termOpen={termOpen}
            onTerm={toggleTerm}
            statsOpen={statsOpen}
            onStats={() => setStatsOpen(true)}
            onRun={() => { setTermOpen(true); toast('Tip: type a command in the terminal and press Enter', 'info'); }}
            onNewFile={() => setModals({ type: 'create', parent: '', kind: 'file' })}
            onPalette={() => setPaletteOpen(true)}
          />

          {statsOpen && <div className="stats-backdrop" onClick={() => setStatsOpen(false)} />}
          <div className={`stats-panel ${statsOpen ? '' : 'stats-closed'}`}>
            <div className="stats-header">
              <span><i className="fa-solid fa-gauge-high" style={{ marginRight: 7 }} /> System</span>
              <button className="icon-btn" title="Close" onClick={() => setStatsOpen(false)}><i className="fas fa-xmark" /></button>
            </div>
            {sysStats ? <StatsContent stats={sysStats} /> : <div className="stats-empty"><div className="spinner" style={{ margin: '0 auto 10px' }} /><div>Connecting to metrics…</div></div>}
          </div>

          {modals && (
            <Modal
              modal={modals}
              onClose={() => setModals(null)}
              onSubmit={modals.type === 'create' ? (name) => createEntry(modals.parent, name, modals.kind) :
                modals.type === 'rename' ? (name) => renameEntry(modals.node, name) :
                () => deleteEntry(modals.node)}
            />
          )}

          {driveModal && (
            <DriveModal
              drive={drive}
              onClose={() => setDriveModal(false)}
              changeDrive={(d) => { setDrive(d); driveRef.current = d; }}
            />
          )}

          {ctxMenu && <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}
          <Palette
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            files={filesList}
            onOpenFile={(p) => {
              setPaletteOpen(false);
              const base = (filesList.find((f) => f.path === p) || {}).name || p.split('/').pop() || p;
              openFile(p, base);
            }}
            onNewFile={() => { setPaletteOpen(false); setModals({ type: 'create', parent: '', kind: 'file' }); }}
            onToggleSidebar={() => { setPaletteOpen(false); setSidebarOpen((v) => !v); }}
            onToggleTerm={() => { setPaletteOpen(false); setTermOpen((v) => !v); }}
            onCloseAll={() => { setPaletteOpen(false); closeAll(); }}
            onSave={async () => { setPaletteOpen(false); await saveActive(); }}
            onRefresh={async () => { setPaletteOpen(false); await loadTree(); }}
          />
          <MultiplayerPanel
            open={mpOpen}
            onClose={() => setMpOpen(false)}
            wsRef={wsRef}
            config={mpConfig}
            pendingJoin={pendingJoin}
            myState={{ inRoom: inRoomRef, myOid: myOidRef }}
            onInviteCode={(code) => { if (code) navigator.clipboard?.writeText(`${location.origin}/?join=${code}`); }}
          />
        </Fragment>
      )}
      <input ref={uploadRef} type="file" multiple style={{ display: 'none' }} onChange={onPickFiles} />
      {authed && <SystemPill stats={sysStats} latency={latency} />}
      {uploads.length > 0 && (
        <div className="upload-panel">
          {uploads.map((u) => (
            <div key={u.id} className={`upload-item ${u.done ? 'done' : ''}`}>
              <i className={`fas ${u.error ? 'fa-circle-exclamation' : u.done ? 'fa-circle-check' : 'fa-cloud-arrow-up'}`} />
              <div className="upload-info">
                <div className="upload-name">{u.name}</div>
                {u.error ? <div className="upload-err">{u.error}</div> : (
                  <div className="upload-bar"><div className="upload-fill" style={{ width: u.pct + '%' }} /></div>
                )}
              </div>
              <span className="upload-pct">{u.error ? '' : u.pct + '%'}</span>
            </div>
          ))}
        </div>
      )}
      <ToastRoot />
      {approvalPending && (
        <div className="freeze-overlay" aria-hidden="true">
          <div className="freeze-card">
            <i className="fa-solid fa-user-clock" style={{ animationDelay: '.3s' }} />
            <p className="freeze-title">Waiting for host approval</p>
            <p className="freeze-wait">You cannot open any file until the host lets you in. Hang tight — it only takes a moment.</p>
          </div>
        </div>
      )}
      {frozenUi && (
        <div className="freeze-overlay" aria-hidden="true">
          <div className="freeze-card">
            <i className="fa-solid fa-snowflake" />
            <p className="freeze-title">You are frozen</p>
            <p className="freeze-wait">Wait for the host to unfreeze you to keep editing.</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TOP BAR
   ============================================================ */
function TopBar({ wsStatus, onRun, onPalette, onSidebar, onTerm, termOpen, onUpload, onSave, canSave, mpReady, inRoom, roomCount, onPeople, driveConnected, onDrive }) {
  return (
    <div className="topbar">
      <button className="icon-btn topbar-hamburger" title="Explorer" onClick={onSidebar}><i className="fa-solid fa-bars" /></button>
      <div className="brand">
        <div className="brand-logo">P</div>
        <span>Project</span><span style={{ color: 'var(--text-muted)' }}>CUI</span>
        <span className="brand-subtitle">self-hosted</span>
      </div>
      <div className="topbar-center">
        <div className="workspace-name">
          <i className="fa-solid fa-folder-open" />
          {location.hostname}
          <span style={{ opacity: .5 }}>·</span>
          workspace
        </div>
      </div>
      <div className="topbar-right">
        {mpReady && (
          <button className={`icon-btn people-btn ${inRoom ? 'active' : ''}`} title={inRoom ? `Collaborate (${roomCount} online)` : 'Collaborate'} onClick={onPeople}>
            <i className="fa-solid fa-people-group" />
            {inRoom && roomCount > 0 && <span className="people-count">{roomCount}</span>}
          </button>
        )}
        <button className={`icon-btn drive-btn ${driveConnected ? 'active' : ''}`} title={driveConnected ? 'Google Drive: connected – auto-backup on save' : 'Connect Google Drive backup'} onClick={onDrive}>
          <i className="fa-brands fa-google-drive" />
          {driveConnected && <span className="drive-dot" />}
        </button>
        <button className={`icon-btn palette-btn`} title="Command palette (Ctrl+K)" onClick={onPalette}><i className="fa-solid fa-magnifying-glass" /></button>
        <button className={`icon-btn term-btn ${termOpen ? 'active' : ''}`} title="Toggle terminal" onClick={onTerm}><i className="fa-solid fa-terminal" /></button>
        <button className="icon-btn upload-btn" title="Upload files" onClick={onUpload}><i className="fa-solid fa-upload" /></button>
        <button className="icon-btn save-btn" title="Save file (Ctrl+S)" disabled={!canSave} onClick={onSave}><i className="fa-solid fa-floppy-disk" /></button>
        <button className="icon-btn sidebar-desktop-btn" title="Toggle sidebar (Ctrl+B)" onClick={onSidebar}><i className="fa-solid fa-panel-left" /></button>
        <button className="run-btn" onClick={onRun}><i className="fas fa-play" /> Run</button>
        <div className={`conn-dot ${wsStatus === 'online' ? '' : 'off'}`} title={wsStatus} />
      </div>
    </div>
  );
}

/* ============================================================
   ACTIVITY BAR
   ============================================================ */
function ActivityBar({ sidebarOpen, setSidebarOpen, onPalette, termOpen, onTerm, onStats, mpReady, inRoom, roomCount, onPeople, driveConnected, onDrive }) {
  return (
    <div className="activity-bar">
      <button className={`icon-btn ${sidebarOpen ? 'active' : ''}`} title="Explorer (Ctrl+B)" onClick={() => setSidebarOpen((v) => !v)}><span>Explorer</span><i className="fa-solid fa-files" /></button>
      <button className="icon-btn" title="Search files" onClick={onPalette}><span>Search</span><i className="fa-solid fa-magnifying-glass" /></button>
      <button className={`icon-btn ${termOpen ? 'active' : ''}`} title="Terminal" onClick={onTerm}><span>Terminal</span><i className="fa-solid fa-terminal" /></button>
      <button className="icon-btn" title="System stats" onClick={onStats}><span>Stats</span><i className="fa-solid fa-gauge-high" /></button>
      {mpReady && (
        <button className={`icon-btn ${inRoom ? 'active' : ''}`} title="Collaborate" onClick={onPeople}><span>Collab</span><i className="fa-solid fa-people-group" />{inRoom && roomCount > 0 && <b className="people-count small">{roomCount}</b>}</button>
      )}
      <button className={`icon-btn drive-btn ${driveConnected ? 'active' : ''}`} title={driveConnected ? 'Google Drive: connected – auto-backup on save' : 'Connect Google Drive backup'} onClick={onDrive}><span>Drive</span><i className="fa-brands fa-google-drive" />{driveConnected && <span className="drive-dot" />}</button>
      <div className="spacer-activity" />
      <button className="icon-btn" title="Settings"><span>Settings</span><i className="fa-solid fa-gear" /></button>
    </div>
  );
}

/* ============================================================
   TABS
   ============================================================ */
function TabsBar({ tabs, activePath, onSelect, onClose, onCloseAll, onNewFile }) {
  const [showCloseAll, setShowCloseAll] = useState(false);
  return (
    <div className="tabs-bar">
      {tabs.map((t) => {
        const icon = fileIconOf(t.name);
        return (
          <div key={t.path} className={`tab-item ${t.path === activePath ? 'active' : ''} ${t.dirty ? 'dirty' : ''}`}
            onClick={() => onSelect(t.path)}
            onContextMenu={(e) => { e.preventDefault(); setShowCloseAll(true); }}>
            <i className={`file-icon ${icon[0]}`} style={{ color: icon[1] }} />
            <span className="tab-title">{t.name}</span>
            <span className="tab-close" onClick={(e) => { e.stopPropagation(); onClose(t.path); }}>
              <i className="fas fa-xmark" />
            </span>
          </div>
        );
      })}
      {(tabs.length > 0 || showCloseAll) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button className="icon-btn" title="Close all" style={{ width: 24, height: 24, fontSize: 11 }} onClick={onCloseAll}><i className="fas fa-stamp" /></button>
        </div>
      )}
      <button className="icon-btn" title="New file" style={{ width: 26, height: 24, fontSize: 12, marginLeft: tabs.length ? 0 : 8 }} onClick={onNewFile}><i className="fas fa-plus" /></button>
      <div className="tabs-gutter" />
    </div>
  );
}

/* ============================================================
   BOTTOM PANEL (Terminal)
   ============================================================ */
const MOD_SEQ = {
  arrowUp: { base: '\x1b[A', shift: '\x1b[1;2A', alt: '\x1b[1;3A', ctrl: '\x1b[1;5A' },
  arrowDown: { base: '\x1b[B', shift: '\x1b[1;2B', alt: '\x1b[1;3B', ctrl: '\x1b[1;5B' },
  arrowRight: { base: '\x1b[C', shift: '\x1b[1;2C', alt: '\x1b[1;3C', ctrl: '\x1b[1;5C' },
  arrowLeft: { base: '\x1b[D', shift: '\x1b[1;2D', alt: '\x1b[1;3D', ctrl: '\x1b[1;5D' },
  home: { base: '\x1b[H', shift: '\x1b[1;2H', alt: '\x1b[1;3H', ctrl: '\x1b[1;5H' },
  end: { base: '\x1b[F', shift: '\x1b[1;2F', alt: '\x1b[1;3F', ctrl: '\x1b[1;5F' },
  pageUp: { base: '\x1b[5~' },
  pageDown: { base: '\x1b[6~' },
};

const STATIC_KEYS = [
  { label: 'C-c', seq: '\x03' },
  { label: 'C-d', seq: '\x04' },
  { label: 'C-z', seq: '\x1a' },
  { label: 'C-l', seq: '\x0c' },
  { label: 'C-u', seq: '\x15' },
  { label: 'C-a', seq: '\x01' },
  { label: 'C-e', seq: '\x05' },
  { label: 'C-w', seq: '\x17' },
];

function TerminalKeys({ onKey }) {
  const [mods, setMods] = useState({ ctrl: false, alt: false, shift: false });

  const toggleMod = (m) => setMods((p) => ({ ...p, [m]: !p[m] }));

  const send = (seq) => {
    onKey(seq);
    setMods({ ctrl: false, alt: false, shift: false });
  };

  const pressArrow = (key) => {
    const map = MOD_SEQ[key];
    send(mods.shift ? (map.shift || map.base) : mods.alt ? (map.alt || map.base) : mods.ctrl ? (map.ctrl || map.base) : map.base);
  };

  return (
    <div className="terminal-keys">
      <div className="term-keys-row">
        <button className={`term-key mod ${mods.ctrl ? 'mod-on' : ''}`} onClick={() => toggleMod('ctrl')}>Ctrl</button>
        <button className={`term-key mod ${mods.alt ? 'mod-on' : ''}`} onClick={() => toggleMod('alt')}>Alt</button>
        <button className={`term-key mod ${mods.shift ? 'mod-on' : ''}`} onClick={() => toggleMod('shift')}>Shift</button>
        <span className="term-keys-sep" />
        <button className="term-key" onClick={() => send('\x1b')}>Esc</button>
        <button className="term-key" onClick={() => send(mods.shift ? '\x1b[Z' : '\t')}>Tab</button>
        <button className="term-key" title="Backspace" onClick={() => send('\x7f')}>⌫</button>
        <button className="term-key" title="Enter" onClick={() => send('\r')}>⏎</button>
      </div>
      <div className="term-keys-row">
        <div className="term-arrow-pad">
          <button className="term-key" onClick={() => pressArrow('arrowUp')}>↑</button>
          <button className="term-key" onClick={() => pressArrow('arrowLeft')}>←</button>
          <button className="term-key" onClick={() => pressArrow('arrowDown')}>↓</button>
          <button className="term-key" onClick={() => pressArrow('arrowRight')}>→</button>
        </div>
        <span className="term-keys-sep" />
        <button className="term-key" onClick={() => pressArrow('home')}>Home</button>
        <button className="term-key" onClick={() => pressArrow('end')}>End</button>
        <button className="term-key" onClick={() => send('\x1b[5~')}>PgUp</button>
        <button className="term-key" onClick={() => send('\x1b[6~')}>PgDn</button>
        <span className="term-keys-sep" />
        {STATIC_KEYS.map((k) => (
          <button className="term-key" key={k.label} onClick={() => send(k.seq)}>{k.label}</button>
        ))}
      </div>
    </div>
  );
}

function BottomPanel({ height, startDrag, onClose, wsRef, closed }) {
  const [tabsState, setTabsState] = useState([]); // {id, title}
  const [activeId, setActiveId] = useState(null);
  const containers = useRef({});
  const nextNum = useRef(1);
  const cmdRef = useRef(null);
  const [keysOpen, setKeysOpen] = useState(
    typeof window !== 'undefined' ? window.innerWidth <= 768 : false
  );

  const wsSend = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }, [wsRef]);

  const spawnTerminal = useCallback((id, num) => {
    const el = containers.current[id];
    if (!el) return;
    if (!window.Terminal) { toast('xterm.js failed to load', 'error'); return; }
    const term = new window.Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      theme: {
        background: '#0a0c10', foreground: '#e6e9f2',
        cursor: '#818cf8', cursorAccent: '#0a0c10',
        selectionBackground: '#6366f155',
        black: '#0b0d13', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e6e9f2',
        brightBlack: '#5c6378', brightRed: '#f87171', brightGreen: '#34d399',
        brightYellow: '#fbbf24', brightBlue: '#60a5fa', brightMagenta: '#c084fc',
        brightCyan: '#22d3ee', brightWhite: '#ffffff',
      },
      scrollback: 5000,
      cursorBlink: true,
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch (_) {}

    const meta = { term, fit, id };
    el.__meta = meta;

    window.setTimeout(() => {
      try { fit.fit(); } catch (_) {}
      wsSend({ type: 'term:start', id, rows: term.rows, cols: term.cols });
    }, 80);

    term.onData((d) => wsSend({ type: 'term:input', id, data: d }));

    const ro = new ResizeObserver(() => {
      if (document.hidden) return;
      try {
        fit.fit();
        wsSend({ type: 'term:resize', id, cols: term.cols, rows: term.rows });
      } catch (_) {}
    });
    ro.observe(el);
    meta.ro = ro;
  }, [wsSend]);

  const addTerm = useCallback(() => {
    const id = 't' + nextNum.current++;
    const num = nextNum.current - 1;
    setTabsState((ts) => [...ts, { id, title: `Terminal ${num}` }]);
    setActiveId(id);
    requestAnimationFrame(() => spawnTerminal(id, num));
  }, [spawnTerminal]);

  const openExistingTerm = useCallback((id, title) => {
    setTabsState((ts) => (ts.some((t) => t.id === id) ? ts : [...ts, { id, title: title || id }]));
    setActiveId(id);
    requestAnimationFrame(() => spawnTerminal(id, 0));
  }, [spawnTerminal]);

  const bootedRef = useRef(false);

  /* Ask the server for sessions each time the panel mounts (so reopening the
     collapsed terminal panel restores the same tabs/sessions). */
  useEffect(() => { wsSend({ type: 'term:list' }); }, [wsSend]);

  const killTerm = useCallback((id) => {
    wsSend({ type: 'term:kill', id });
    const el = containers.current[id];
    if (el && el.__meta) {
      try { el.__meta.ro.disconnect(); } catch (_) {}
      try { el.__meta.term.dispose(); } catch (_) {}
    }
    delete containers.current[id];
    setTabsState((ts) => {
      const next = ts.filter((t) => t.id !== id);
      return next;
    });
  }, [wsSend]);

  /* Restore persistent terminal sessions from the server after (re)connect */
  useEffect(() => {
    const handler = (e) => {
      const m = e.detail;
      if (!m) return;
      if (m.type === 'term:sessions') {
        const sessions = Array.isArray(m.sessions) ? m.sessions : [];
        if (!bootedRef.current) {
          bootedRef.current = true;
          if (sessions.length === 0) { addTerm(); return; }
          sessions.forEach((s) => openExistingTerm(s.id, s.title));
          const maxN = sessions.reduce((acc, s) => {
            const n = parseInt(String(s.id || '').replace(/\D/g, ''), 10);
            return Number.isFinite(n) ? Math.max(acc, n) : acc;
          }, 0);
          if (maxN >= nextNum.current) nextNum.current = maxN + 1;
        }
      } else if (m.type === 'term:closed') {
        if (containers.current[m.id]) killTerm(m.id);
      }
    };
    window.addEventListener('nova-ws', handler);
    return () => window.removeEventListener('nova-ws', handler);
  }, [addTerm, openExistingTerm, killTerm]);

  useEffect(() => {
    if (tabsState.length === 0) return;
    if (!tabsState.some((t) => t.id === activeId)) {
      setActiveId(tabsState[tabsState.length - 1].id);
    }
  }, [tabsState]);

  /* Incoming WS terminal messages */
  useEffect(() => {
    const handler = (e) => {
      const m = e.detail;
      if (!m || (m.type !== 'term:data' && m.type !== 'term:exit' && m.type !== 'term:error' && m.type !== 'term:ready' && m.type !== 'term:history')) return;
      Object.entries(containers.current).forEach(([id, el]) => {
        const meta = el && el.__meta;
        if (!meta || meta.id !== m.id) return;
        if (m.type === 'term:ready') {
          try { meta.fit.fit(); } catch (_) {}
        } else if (m.type === 'term:history') {
          meta.term.write(m.data || '');
          try { meta.fit.fit(); } catch (_) {}
        } else if (m.type === 'term:data') {
          meta.term.write(m.data);
        } else if (m.type === 'term:exit') {
          if (m.code === 0) meta.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
          else meta.term.write(`\r\n\x1b[31m[process exited with code ${m.code}]\x1b[0m\r\n`);
        } else if (m.type === 'term:error') {
          meta.term.write(`\r\n\x1b[31m${m.error}\x1b[0m\r\n`);
        }
      });
    };
    window.addEventListener('nova-ws', handler);
    return () => window.removeEventListener('nova-ws', handler);
  }, []);

  /* Re-fit terminals on window / mobile keyboard size changes */
  useEffect(() => {
    const refit = () => {
      Object.values(containers.current).forEach((el) => {
        const m = el && el.__meta;
        if (m) { try { m.fit.fit(); } catch (_) {} }
      });
    };
    window.addEventListener('resize', refit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);
    return () => {
      window.removeEventListener('resize', refit);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', refit);
    };
  }, []);

  const runCommand = useCallback(() => {
    const input = cmdRef.current;
    const v = input && input.value.trim();
    if (!activeId) return;
    const t = tabsState.find((x) => x.id === activeId);
    if (t) {
      if (v) wsSend({ type: 'term:input', id: activeId, data: v + '\r' });
      if (input) input.value = '';
    }
  }, [activeId, tabsState, wsSend]);

  return (
    <div className={`bottom-panel${closed ? ' closed' : ''}`} style={{ height }}>
      <div className="bottom-panel-handle" onMouseDown={startDrag} />
      <div className="terminal-header">
        {tabsState.map((t) => (
          <div key={t.id} className={`terminal-tab ${t.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(t.id)}>
            <i className="fas fa-terminal" style={{ fontSize: 10, color: t.id === activeId ? 'var(--accent-3)' : 'var(--text-faint)' }} />
            {t.title}
            <span className="term-close" onClick={(e) => { e.stopPropagation(); killTerm(t.id); }}><i className="fas fa-xmark" /></span>
          </div>
        ))}
        <button className="icon-btn" title="New terminal" style={{ width: 22, height: 22, fontSize: 10 }} onClick={addTerm}>
          <i className="fas fa-plus" />
        </button>
        <div className="terminal-header-right">
          <button className="icon-btn" title="Clear output" onClick={() => { const el = containers.current[activeId]; if (el && el.__meta) el.__meta.term.clear(); }}><i className="fas fa-broom" /></button>
          <button className={`icon-btn ${keysOpen ? 'active' : ''}`} title="Virtual keys" onClick={() => setKeysOpen((v) => !v)}><i className="fa-solid fa-keyboard" /></button>
          <button className="icon-btn" title="Terminate process" onClick={() => activeId && killTerm(activeId)}><i className="fas fa-skull-crossbones" /></button>
          <button className="icon-btn" title="Collapse panel" onClick={onClose}><i className="fas fa-chevron-down" /></button>
        </div>
      </div>
      <div className="terminal-commandbar">
        <form onSubmit={(e) => { e.preventDefault(); runCommand(); }}>
          <i className="fa-solid fa-chevron-right" />
          <input ref={cmdRef} placeholder="Type a command and press Enter…" autoCapitalize="off" autoCorrect="off" spellCheck="false" enterKeyHint="send" />
          <button type="submit" title="Run command"><i className="fa-solid fa-play" /></button>
        </form>
      </div>
      <div className="terminal-body" style={{ flex: 1, minHeight: 0 }}>
        {tabsState.map((t) => (
          <div key={t.id} ref={(el) => { containers.current[t.id] = el; }}
            style={{ position: 'absolute', inset: 0, display: t.id === activeId ? 'block' : 'none', padding: '8px 4px 8px 10px' }} />
        ))}
      </div>
      {keysOpen && (
        <TerminalKeys onKey={(seq) => { if (activeId) wsSend({ type: 'term:input', id: activeId, data: seq }); }} />
      )}
    </div>
  );
}

/* ============================================================
   MOBILE NAV BAR (bottom)
   ============================================================ */
function MobileNav({ sidebarOpen, onSidebar, termOpen, onTerm, statsOpen, onStats, onRun, onNewFile, onPalette }) {
  return (
    <div className="mobile-nav">
      <button className={sidebarOpen ? 'active' : ''} onClick={onSidebar}>
        <i className="fa-solid fa-files" />
        Files
      </button>
      <button className={termOpen ? 'active' : ''} onClick={onTerm}>
        <i className="fa-solid fa-terminal" />
        Terminal
      </button>
      <button onClick={onNewFile}>
        <i className="fa-solid fa-file-circle-plus" />
        New
      </button>
      <button onClick={onPalette}>
        <i className="fa-solid fa-magnifying-glass" />
        Find
      </button>
      <button className={statsOpen ? 'active' : ''} onClick={onStats}>
        <i className="fa-solid fa-gauge-high" />
        Stats
      </button>
      <button onClick={onRun}>
        <i className="fa-solid fa-play" />
        Run
      </button>
    </div>
  );
}

/* ============================================================
   STATUS BAR
   ============================================================ */
function StatusBar({ statusInfo, activeTab, wsStatus, termOpen, onTerm }) {
  return (
    <div className="statusbar">
      <span><i className="fa-solid fa-branch" /> main</span>
      <span className="status-sep">·</span>
      <span><i className="fa-solid fa-circle-check" style={{ color: '#111' }} /> {wsStatus === 'online' ? 'Connected' : 'Reconnecting…'}</span>
      <span className="status-sep">·</span>
      <span><i className="fa-solid fa-terminal" style={{ color: '#111' }} /> {termOpen ? 'Terminal ready' : 'Terminal hidden'}</span>
      {activeTab && (<Fragment>
        <span className="status-sep">·</span>
        <span><i className="fa-solid fa-file-lines" style={{ color: '#111' }} /> {activeTab.path}</span>
        {activeTab.dirty && <span style={{ color: '#ffe08a' }}><i className="fa-solid fa-circle-dot" /> unsaved</span>}
      </Fragment>)}
      <div className="statusbar-right">
        {statusInfo.pos && <span>{statusInfo.pos}</span>}
        {statusInfo.system?.node && <span>{statusInfo.system.platform} · Node {statusInfo.system.node}</span>}
        <span><i className="fa-solid fa-microchip" style={{ color: '#111' }} /> {statusInfo.system?.cpus ?? ''}</span>
        <span><i className="fa-solid fa-shield-halved" /> Sandboxed</span>
        <span style={{ cursor: 'pointer' }} onClick={onTerm}>⌘</span>
      </div>
    </div>
  );
}

/* ============================================================
   RESIZE HANDLE
   ============================================================ */
function ResizeHandle({ onMouseDown, className }) {
  return <div className={className} onMouseDown={onMouseDown} style={{ width: 3, cursor: 'col-resize', background: 'transparent', zIndex: 5, flexShrink: 0, position: 'relative' }} />;
}

/* ============================================================
   MODAL
   ============================================================ */
function Modal({ modal, onClose, onSubmit }) {
  const [val, setVal] = useState(modal.type === 'rename' ? (modal.node ? modal.node.name : '') : '');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); inputRef.current && inputRef.current.select(); }, []);
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const isDelete = modal.type === 'confirmDel';
  const title = modal.type === 'create' ? `New ${modal.kind === 'directory' ? 'folder' : 'file'}` :
    modal.type === 'rename' ? 'Rename' : 'Delete';

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <i className={`fas ${isDelete ? 'fa-triangle-exclamation' : modal.type === 'rename' ? 'fa-pen' : 'fa-plus'}`} style={{ color: isDelete ? 'var(--red)' : undefined }} />
          {title}
        </h3>
        {isDelete ? (
          <div className="modal-desc">
            Are you sure you want to delete <b style={{ color: 'var(--text)' }}>{modal.node?.name}</b>? This cannot be undone.
          </div>
        ) : (
          <div className="modal-desc">
            Name for {modal.kind === 'directory' ? 'the folder' : 'the file'}
            {modal.parent ? <> in <b style={{ color: 'var(--text)' }}>{modal.parent}</b></> : ' in the root'}.
          </div>
        )}
        {!isDelete && (
          <input ref={inputRef} type="text" value={val}
            placeholder={modal.kind === 'directory' ? 'folder-name' : 'file.txt'}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) onSubmit(val.trim()); }} />
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {isDelete ? (
            <button className="btn btn-danger" onClick={() => onSubmit()}>Delete</button>
          ) : (
            <button className="btn btn-primary" disabled={!val.trim()} onClick={() => onSubmit(val.trim())}>Create</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   GOOGLE DRIVE BACKUP MODAL
   ============================================================ */
function DriveModal({ drive, onClose, changeDrive }) {
  const [view, setView] = useState(null); // {configured, url}
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('GET', '/api/gdrive/auth-url')
      .then((d) => setView({ configured: !!d.configured, url: d.url || '' }))
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const connect = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('POST', '/api/gdrive/token', { code: code.trim() });
      changeDrive({ configured: true, connected: true, email: r.email || null });
      toast('Google Drive connected – files auto-backup on save', 'success');
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    try { await api('POST', '/api/gdrive/disconnect'); } catch (_) {}
    changeDrive({ configured: true, connected: false, email: null });
    toast('Google Drive disconnected', 'info');
    onClose();
  };

  const openAuth = () => { if (view && view.url) window.open(view.url, '_blank', 'noopener'); };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal drive-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3><i className="fa-brands fa-google-drive" style={{ color: '#34a853' }} /> Google Drive backup</h3>
        {busy && <div className="modal-desc"><span className="spinner inline drive-spinner" /> Checking code…</div>}
        {!busy && !view && <div className="modal-desc">Loading…</div>}
        {!busy && view && !view.configured && (
          <div className="modal-desc">
            Google Drive isn't set up on this server yet.<br />
            <span className="drive-mono">An admin must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET</span> to enable it.
          </div>
        )}
        {!busy && view && view.configured && drive && !drive.connected && (
          <div className="drive-steps">
            <div className="drive-step"><b>1.</b> Open Google sign-in, then copy the code it shows on screen.</div>
            <button className="btn btn-ghost" onClick={openAuth}><i className="fa-solid fa-arrow-up-right-from-square" style={{ marginRight: 6 }} /> Open Google sign-in</button>
            <div className="drive-step"><b>2.</b> Paste that code below and connect:</div>
            <input type="text" className="drive-code-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Google authorization code" spellCheck="false" autoFocus />
            {err && <div className="login-error"><i className="fas fa-circle-exclamation" /> {err}</div>}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!code.trim()} onClick={connect}><i className="fa-brands fa-google-drive" style={{ marginRight: 6 }} /> Connect</button>
            </div>
          </div>
        )}
        {!busy && view && view.configured && drive && drive.connected && (
          <div className="drive-steps">
            <div className="modal-desc drive-connected-note">
              <i className="fa-solid fa-circle-check drive-check" /> Connected to <b>{drive.email || 'Google Drive'}</b>.<br />
              Every save, new file, rename and delete is backed up to a <b>Project CUI</b> folder in your Drive.
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={disconnect}><i className="fa-solid fa-link-slash" style={{ marginRight: 6 }} /> Disconnect</button>
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   CONTEXT MENU
   ============================================================ */
function ContextMenu({ menu, onClose }) {
  const ref = useRef(null);
  useClickOutside(ref, onClose);
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const pos = {
    left: Math.min(menu.x, window.innerWidth - 220),
    top: Math.min(menu.y, window.innerHeight - menu.items.length * 34 - 20),
  };
  return (
    <div className="context-menu" ref={ref} style={pos}>
      {menu.items.map((it, i) => it.sep ? (
        <div key={i} className="context-menu-sep" />
      ) : (
        <div key={i} className={`context-menu-item ${it.danger ? 'danger' : ''}`} onClick={() => { it.fn(); onClose(); }}>
          <i className={`fas ${it.icon}`} />
          {it.label}
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   FALLBACK EDITOR (used if Monaco fails to load)
   ============================================================ */
function FallbackEditor({ path, initial, registerGet, registerApply, onDirty, onRelay }) {
  const taRef = useRef(null);
  const preRef = useRef(null);
  const [val, setVal] = useState(initial || '');

  const syncScroll = () => {
    const ta = taRef.current, pre = preRef.current;
    if (ta && pre) { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; }
  };

  useEffect(() => { setVal(initial || ''); }, [path, initial]);
  useEffect(() => {
    if (taRef.current) { taRef.current.focus(); taRef.current.setSelectionRange(0, 0); }
  }, [path]);
  useEffect(() => {
    registerGet(() => (taRef.current ? taRef.current.value : ''));
    return () => registerGet(null);
  }, [registerGet]);
  useEffect(() => {
    if (!registerApply) return;
    registerApply((editsOrText) => {
      const prev = taRef.current ? taRef.current.value : val;
      const next = typeof editsOrText === 'string' ? editsOrText : applyEditsToText(prev, editsOrText);
      setVal(next);
      return next;
    });
    return () => registerApply(null);
  }, [registerApply]);

  return (
    <div className="fallback-wrap">
      <pre
        ref={preRef}
        className="fallback-pre"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlightCode(val, path) }}
      />
      <textarea
        ref={taRef}
        className="fallback-editor"
        value={val}
        onChange={(e) => { setVal(e.target.value); onDirty(path); if (onRelay) onRelay(); }}
        onScroll={syncScroll}
        placeholder="Plain-text editing (code editor failed to load)"
        spellCheck="false"
        autoCorrect="off"
        autoCapitalize="off"
        wrap="off"
      />
    </div>
  );
}

/* ============================================================
   COMMAND PALETTE (Ctrl+K)
   ============================================================ */
function Palette({ open, onClose, files, onOpenFile, onNewFile, onToggleSidebar, onToggleTerm, onCloseAll, onSave, onRefresh }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const ref = useRef(null);

  const commands = useMemo(() => {
    const cmds = [
      { name: 'New file…', icon: 'fa-file', fn: onNewFile, keys: '' },
      { name: 'Save file', icon: 'fa-floppy-disk', fn: onSave, keys: '⌘S' },
      { name: 'Toggle sidebar', icon: 'fa-panel-left', fn: onToggleSidebar, keys: '⌘B' },
      { name: 'Toggle terminal', icon: 'fa-terminal', fn: onToggleTerm, keys: '⌘`' },
      { name: 'Close all tabs', icon: 'fa-square-xmark', fn: onCloseAll },
      { name: 'Refresh file tree', icon: 'fa-rotate', fn: onRefresh },
      { name: 'Go to file', icon: 'fa-magnifying-glass', fn: null },
    ];
    const fileResults = files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
      .map((f) => ({ name: f.path, icon: 'fa-file-code', fn: null, file: true, keys: '' }));
    const filteredCmds = cmds.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || (c.keys || '').toLowerCase().includes(q.toLowerCase()));
    if (q && !fileResults.length) return filteredCmds;
    return q ? fileResults.concat(filteredCmds) : [...fileResults, ...filteredCmds];
  }, [q, files]);

  useEffect(() => {
    if (open) { setQ(''); setIdx(0); setTimeout(() => ref.current && ref.current.focus(), 20); }
  }, [open]);

  useEffect(() => { setIdx(0); }, [q]);

  useEffect(() => {
    if (!open) return;
    const h = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, commands.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
      if (e.key === 'Enter' && commands[idx]) {
        const c = commands[idx];
        if (c.file) onOpenFile(c.name);
        else c.fn && c.fn();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, commands, idx]);

  if (!open) return null;
  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={ref} placeholder="Type a command or search to find a file…" value={q}
          onChange={(e) => setQ(e.target.value)} />
        <div className="palette-list">
          {commands.map((c, i) => (
            <div key={c.name + i} className={`palette-item ${i === idx ? 'active' : ''}`}
              onMouseEnter={() => setIdx(i)} onClick={() => { if (c.file) onOpenFile(c.name); else c.fn && c.fn(); }}>
              <i className={`fas ${c.icon}`} />
              <span>{c.name}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </div>
          ))}
          {!commands.length && <div className="palette-empty">No results for “{q}”</div>}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   SYSTEM STATS PANEL
   ============================================================ */
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return Math.round(n) + ' B';
}
function fmtUptime(s) {
  if (s == null || isNaN(s)) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
function StatsContent({ stats }) {
  const cpu = Math.min(100, Math.max(0, stats.cpu || 0));
  const mem = Math.min(100, Math.max(0, stats.memPct || 0));
  return (
    <div className="stats-content">
      <div className="stat-card">
        <div className="stat-row"><span>CPU</span><b className={cpu > 85 ? 'warn' : ''}>{cpu}%</b></div>
        <div className="stat-bar"><div className="stat-fill cpu" style={{ width: cpu + '%' }} /></div>
      </div>
      <div className="stat-card">
        <div className="stat-row"><span>Memory</span><b className={mem > 85 ? 'warn' : ''}>{fmtBytes(stats.memUsed)} / {fmtBytes(stats.memTotal)} · {mem}%</b></div>
        <div className="stat-bar"><div className="stat-fill mem" style={{ width: mem + '%' }} /></div>
      </div>
      <div className="stat-card">
        <div className="stat-row"><span>Load avg</span><b>{Array.isArray(stats.load) ? stats.load.join(' / ') : '—'}</b></div>
        <div className="stat-row"><span>Uptime</span><b>{fmtUptime(stats.uptime)}</b></div>
      </div>
      <div className="stat-card">
        <div className="stat-title">Top processes</div>
        <table className="proc-table">
          <thead><tr><th>Process</th><th>CPU</th><th>Mem</th></tr></thead>
          <tbody>
            {(stats.procs || []).map((p, i) => (
              <tr key={i}><td className="proc-name">{p.name}</td><td>{p.cpu}%</td><td>{p.mem} MB</td></tr>
            ))}
            {(!stats.procs || !stats.procs.length) && <tr><td colSpan="3">No data</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================================================
   SYSTEM PILL (realtime RAM / storage / OS / latency - bottom-right)
   ============================================================ */
function SystemPill({ stats, latency }) {
  const mem = stats && stats.memPct != null ? stats.memPct : null;
  const disk = stats && stats.disk ? stats.disk.pct : null;
  const osn = (stats && stats.os) || '';
  const memC = mem == null ? 'var(--text-faint)' : mem > 85 ? 'var(--red)' : mem > 60 ? 'var(--yellow)' : 'var(--green)';
  const latC = latency == null || latency <= 80 ? 'var(--green)' : latency <= 250 ? 'var(--yellow)' : 'var(--red)';
  const memTxt = mem == null ? '—' : mem + '%';
  const diskTxt = disk == null ? '—' : disk + '%';
  const osIcon = osn === 'darwin' ? 'fa-apple' : osn === 'win32' ? 'fa-windows' : osn === 'linux' ? 'fa-linux' : 'fa-microchip';
  return (
    <div className="sys-pill">
      <span title="Memory (RAM)"><i className="fa-solid fa-memory" style={{ color: memC }} />{memTxt}</span>
      <span title="Storage (disk)"><i className="fa-solid fa-hard-drive" />{diskTxt}</span>
      <span title="Operating system"><i className={`fa-brands ${osIcon}`} />{osn || 'sys'}</span>
      <span className="sys-lat" title="Internet connection latency" style={{ color: latC }}>
        <i className="fa-solid fa-wifi" />{latency != null ? latency + 'ms' : '—'}
      </span>
    </div>
  );
}

/* ============================================================
   ACCESS SCREEN (username-only: creates a private folder per user)
   ============================================================ */
function LoginScreen({ onAuthed, pendingJoin }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = (d) => {
    localStorage.setItem('pc-token', d.token);
    localStorage.setItem('pc-user', JSON.stringify({ username: d.username, color: d.color, folder: d.folder }));
    onAuthed && onAuthed(d);
  };

  const submit = async (ev) => {
    ev.preventDefault();
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not enter');
      apply(d);
    } catch (ex) {
      setBusy(false);
      setErr(ex.message);
    }
  };

  return (
    <div className="login-root">
      <div className="login-card">
        <div className="login-logo">P</div>
        <div className="login-title">Project CUI</div>
        <div className="login-sub">Enter a username, and you'll get your own folder named {name ? `“${name}”` : 'after you'} and can edit the shared codebase.</div>
        <form onSubmit={submit}>
          <label>Username</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maya" maxLength={24} autoFocus autoComplete="username" spellCheck="false" />
          <button className="btn btn-primary login-btn" disabled={busy || !name.trim()}>
            {busy ? <span className="spinner inline" /> : <i className="fa-solid fa-right-to-bracket" />} Enter workspace
          </button>
          {err && <div className="login-error"><i className="fas fa-circle-exclamation" /> {err}</div>}
        </form>
        <div className="login-foot">Note: remember to back up your projects regularly so you never lose your work.</div>
      </div>
    </div>
  );
}

/* ============================================================
   MEDIA PREVIEW (image / video / audio)
   ============================================================ */
function MediaPreview({ path, kind, name }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let ok = true; let url = null;
    const token = localStorage.getItem('pc-token') || '';
    (async () => {
      try {
        const res = await fetch('/api/fs/media?path=' + encodeURIComponent(path), {
          headers: { Authorization: 'Bearer ' + token },
        });
        if (!res.ok) throw new Error('Could not load media');
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        if (ok) setSrc(url);
      } catch (e) { ok && setErr(e.message); }
    })();
    return () => { ok = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  return (
    <div className="media-preview">
      {!src && !err && <div className="spinner" />}
      {err && <div className="media-err">{err}</div>}
      {kind === 'image' && src && <img src={src} alt={name} />}
      {kind === 'video' && src && <video src={src} controls autoPlay playsInline />}
      {kind === 'audio' && src && <audio src={src} controls autoPlay />}
      <div className="media-name">{name}</div>
    </div>
  );
}

/* ============================================================
   MULTIPLAYER PANEL (rooms / chat / voice / admin tools)
   ============================================================ */
function MultiplayerPanel({ open, onClose, wsRef, config, pendingJoin }) {
  const cfg = config || {};
  const [room, setRoom] = useState(null);        // {id, name, requireApproval, myOid, hostOid}
  const [myOid, setMyOid] = useState(null);
  const [players, setPlayers] = useState([]);
  const [pending, setPending] = useState([]);
  const [roomName, setRoomName] = useState('');
  const [joinCode, setJoinCode] = useState(pendingJoin || '');
  const [chat, setChat] = useState([]);
  const [chatText, setChatText] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [audioPeers, setAudioPeers] = useState([]);
  const [savedJoin] = useState(pendingJoin || '');

  const roomRef = useRef(null);
  const playersRef = useRef([]);
  const myOidRef2 = useRef(null);
  const micOnRef = useRef(false);
  const startRef = useRef(Date.now());
  const invCfgRef = useRef(cfg);
  invCfgRef.current = cfg;
  const streamRef = useRef(null);
  const pcMapRef = useRef(new Map());
  const audioRefs = useRef(new Map());
  const voiceHostRef = useRef(null);
  const chatScrollRef = useRef(null);
  const myName = () => {
    try { return JSON.parse(localStorage.getItem('pc-user') || '{}').username || 'me'; } catch (e) { return 'me'; }
  };
  const myColor = () => {
    try { return JSON.parse(localStorage.getItem('pc-user') || '{}').color || '#8c93a8'; } catch (e) { return '#8c93a8'; }
  };

  const wsSend = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }, [wsRef]);

  const pushSys = useCallback((text) => {
    setChat((c) => [...c, { sys: true, text }]);
  }, []);

  /* Auto-scroll chat */
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  /* ---------------- Voice engine (WebRTC full mesh) ---------------- */

  /* Persistent hidden container for remote audio - must exist even when the
     panel is closed, otherwise incoming tracks have no DOM node and never play. */
  useEffect(() => {
    let host = document.getElementById('mp-voicehost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'mp-voicehost';
      host.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;';
      document.body.appendChild(host);
    }
    voiceHostRef.current = host;
    return () => {
      if (host && host.parentNode) host.parentNode.removeChild(host);
    };
  }, []);

  /* Autoplay unlock - call right after a user gesture (mic toggle). */
  function unlockAudio() {
    try { const a = document.createElement('audio'); a.muted = true; a.play().catch(() => {}); } catch (_) {}
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const c = new Ctx(); c.resume && c.resume();
    } catch (_) {}
  }

  function getAudioEl(peerOid) {
    const key = String(peerOid);
    if (audioRefs.current.has(key)) return audioRefs.current.get(key);
    if (!voiceHostRef.current) {
      let host = document.getElementById('mp-voicehost');
      if (!host) {
        host = document.createElement('div');
        host.id = 'mp-voicehost';
        host.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;';
        document.body.appendChild(host);
      }
      voiceHostRef.current = host;
    }
    const el = document.createElement('audio');
    el.autoplay = true;
    el.playsInline = true;
    voiceHostRef.current.appendChild(el);
    audioRefs.current.set(key, el);
    return el;
  }

  function addAudioPeer(peerOid) {
    setAudioPeers((xs) => (xs.includes(String(peerOid)) ? xs : [...xs, String(peerOid)]));
  }

  function ensurePC(peerOid) {
    const key = String(peerOid);
    let pc = pcMapRef.current.get(key);
    if (pc) return pc;
    const impolite = String(myOidRef2.current) > String(peerOid);
    const stun = (invCfgRef.current && invCfgRef.current.stun) || 'stun:stun.l.google.com:19302';
    try {
      const RTCP = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      pc = new RTCP({ iceServers: [{ urls: ['stun:' + stun.replace(/^stun:/, '')] }] });
    } catch (e) {
      return null;
    }
    pc._impolite = impolite;
    pc._started = false;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) wsSend({ type: 'mp:ice', to: peerOid, candidate: ev.candidate });
    };
    pc.ontrack = (ev) => {
      const el = getAudioEl(peerOid);
      if (el && ev.streams && ev.streams[0] && el.srcObject !== ev.streams[0]) {
        el.srcObject = ev.streams[0];
        addAudioPeer(peerOid);
        el.play && el.play().catch(() => {});
      }
    };
    pc.onnegotiationneeded = () => {
      if (pc._impolite && micOnRef.current && pc.signalingState !== 'closed') {
        doOffer(peerOid);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc && ['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // keep closed peers for cleanup on leave
      }
    };
    pcMapRef.current.set(key, pc);
    return pc;
  }

  function attachTracks(peerOid) {
    const pc = ensurePC(peerOid);
    const stream = streamRef.current;
    if (!pc || !stream) return;
    const track = stream.getAudioTracks()[0];
    if (track && !pc.getSenders().some((s) => s.track === track)) {
      try { pc.addTrack(track, stream); } catch (_) {}
    }
  }

  async function doOffer(peerOid) {
    const pc = ensurePC(peerOid);
    if (!pc || pc._started || pc.signalingState === 'closed' || pc.signalingState === 'have-local-offer') return;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      wsSend({ type: 'mp:offer', to: peerOid, sdp: pc.localDescription });
      pc._started = true;
    } catch (_) {}
  }

  /* Keep a mesh with everyone. Only talkers (mic on) initiate offers so a
     mic-off listener never causes glare. For mic-on targets we respect the
     impolite/polite split; for mic-off targets we always pull them in. */
  const lastSyncAtRef = useRef(0);
  function syncPeers() {
    if (!micOnRef.current) return;
    const now = Date.now();
    if (now - lastSyncAtRef.current < 800) return;
    lastSyncAtRef.current = now;
    const me = String(myOidRef2.current);
    playersRef.current.forEach((p) => {
      const pid = String(p.oid);
      if (!p.oid || pid === me) return;
      const impolite = String(myOidRef2.current) > pid;
      const pc = ensurePC(pid);
      if (!pc) return;
      attachTracks(pid);
      if (p.mic) { if (impolite) doOffer(pid); }
      else doOffer(pid);
    });
  }

  async function onNeedVoice(from) {
    if (!micOnRef.current) return;
    attachTracks(from);
    if (String(myOidRef2.current) > String(from)) await doOffer(from);
  }

  async function onOffer(from, sdp) {
    const pc = ensurePC(from);
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer') return; // glare → keep ours
      attachTracks(from); // we must send our audio in the answer too
      await pc.setRemoteDescription(sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      wsSend({ type: 'mp:answer', to: from, sdp: pc.localDescription });
      pc._started = true;
    } catch (e) { console.warn('offer', e); }
  }

  async function onAnswer(from, sdp) {
    const pc = pcMapRef.current.get(String(from));
    if (!pc) return;
    try {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(sdp);
        pc._started = true;
      }
    } catch (e) {}
  }

  async function onIce(from, candidate) {
    if (!candidate) return;
    const pc = ensurePC(from);
    if (!pc) return;
    try { await pc.addIceCandidate(candidate); } catch (_) {}
  }

  function cleanPeer(peerOid) {
    const key = String(peerOid);
    const pc = pcMapRef.current.get(key);
    if (pc) { try { pc.close(); } catch (_) {} pcMapRef.current.delete(key); }
    const el = audioRefs.current.get(key);
    if (el) {
      try { el.srcObject = null; } catch (_) {}
      try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {}
      audioRefs.current.delete(key);
    }
    setAudioPeers((xs) => xs.filter((x) => x !== key));
  }

  function closeAllPcs() {
    pcMapRef.current.forEach((pc) => { try { pc.close(); } catch (_) {} });
    pcMapRef.current.clear();
    audioRefs.current.forEach((el) => { try { el.srcObject = null; } catch (_) {} try { el.parentNode && el.parentNode.removeChild(el); } catch (_) {} });
    audioRefs.current.clear();
    setAudioPeers([]);
  }

  function stopMicStream() {
    const s = streamRef.current;
    if (s) {
      try { s.getTracks().forEach((t) => t.stop()); } catch (_) {}
      streamRef.current = null;
    }
  }

  async function toggleMic() {
    if (micOn) {
      micOnRef.current = false;
      setMicOn(false);
      stopMicStream();
      wsSend({ type: 'mp:mic', on: false });
      closeAllPcs();
      return;
    }
    setVoiceBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      unlockAudio();
      streamRef.current = stream;
      micOnRef.current = true;
      setMicOn(true);
      wsSend({ type: 'mp:mic', on: true });
      wsSend({ type: 'mp:needvoice' });
      syncPeers();
      setAudioPeers(playersRef.current
        .filter((p) => String(p.oid) !== String(myOidRef2.current))
        .map((p) => String(p.oid)));
    } catch (err) {
      toast('Microphone unavailable: ' + (err && err.message ? err.message : 'denied'), 'error');
    } finally { setVoiceBusy(false); }
  }

  /* ---------------- Room actions ---------------- */
  function createRoom() {
    wsSend({ type: 'mp:create', name: roomName.trim() || '' });
    setRoomName('');
  }
  function joinRoom() {
    const code = joinCode.trim().toUpperCase();
    if (!code) return toast('Enter an invite code', 'error');
    wsSend({ type: 'mp:join', roomId: code });
  }
  function leaveRoom() {
    wsSend({ type: 'mp:leave' });
  }
  function copyInvite() {
    const code = room && room.id;
    if (!code) return;
    const url = `${location.origin}/?join=${code}`;
    if (navigator.clipboard) { try { navigator.clipboard.writeText(url); toast('Invite link copied', 'success'); return; } catch (_) {} }
    toast(url, 'info');
  }
  function sendChat() {
    const t = chatText.trim();
    if (!t) return;
    setChat((c) => [...c, { name: myName(), color: myColor(), text: t }]);
    wsSend({ type: 'mp:chat', text: t });
    setChatText('');
  }
  function resetRoom() {
    roomRef.current = null;
    myOidRef2.current = null;
    setRoom(null); setMyOid(null); setPlayers([]); setPending([]);
    closeAllPcs();
    stopMicStream();
    micOnRef.current = false;
    setMicOn(false);
    setChatText('');
  }

  /* ---------------- Incoming WS messages ---------------- */
  useEffect(() => {
    const h = (e) => {
      const m = e.detail;
      if (!m) return;
      switch (m.type) {
        case 'mp:joined': {
          myOidRef2.current = m.myOid;
          roomRef.current = { id: m.roomId, name: m.roomName, requireApproval: m.requireApproval, myOid: m.myOid };
          playersRef.current = m.players || [];
          setMyOid(m.myOid); setRoom(roomRef.current); setPlayers(playersRef.current); setPending([]);
          pushSys(`Joined room ${m.roomName} (${m.roomId})`);
          toast(`You joined ${m.roomName || 'the room'}`, 'success');
          syncPeers();
          break;
        }
        case 'mp:pending': {
          roomRef.current = { ...(roomRef.current || {}), id: m.roomId, name: m.roomName, pendingMe: true };
          setRoom(roomRef.current);
          pushSys('Join request sent – waiting for host approval…');
          toast('Join request sent – waiting for host approval', 'info');
          break;
        }
        case 'mp:join': {
          if (m.oid !== myOidRef2.current && m.name) toast(`${m.name} joined the room`, 'success');
          if (m.oid && !playersRef.current.some((x) => String(x.oid) === String(m.oid))) {
            playersRef.current = [...playersRef.current, { oid: m.oid, name: m.name, color: m.color, mic: false, isHost: false }];
          }
          syncPeers();
          break;
        }
        case 'mp:leave': {
          if (m.oid !== myOidRef2.current && m.name) toast(`${m.name} left the room`, 'info');
          break;
        }
        case 'mp:players': {
          const pl = m.players || [];
          playersRef.current = pl;
          setPlayers(pl); setPending(m.pending || []);
          if (roomRef.current) {
            roomRef.current.requireApproval = m.requireApproval;
            roomRef.current.name = m.roomName || roomRef.current.name;
            setRoom({ ...roomRef.current });
          }
          // prune dead audio peers
          const ids = new Set(pl.map((p) => String(p.oid)));
          audioRefs.current.forEach((el, k) => { if (!ids.has(k)) cleanPeer(k); });
          syncPeers();
          break;
        }
        case 'mp:joinRequest': {
          setPending(m.pending || []);
          const first = m.pending && m.pending[0];
          if (first && first.name) toast(`${first.name} wants to join`, 'info');
          break;
        }
        case 'mp:chat': {
          if (m.oid === myOidRef2.current) break;
          setChat((c) => [...c, { name: m.name, color: m.color, text: m.text }]);
          break;
        }
        case 'mp:voiceoff': {
          if (m.oid !== myOidRef2.current) cleanPeer(m.oid);
          break;
        }
        case 'mp:needvoice': {
          if (m.from === myOidRef2.current) break;
          onNeedVoice(m.from);
          break;
        }
        case 'mp:offer': {
          if (m.from === myOidRef2.current) break;
          onOffer(m.from, m.sdp);
          break;
        }
        case 'mp:answer': {
          if (m.from === myOidRef2.current) break;
          onAnswer(m.from, m.sdp);
          break;
        }
        case 'mp:ice': {
          if (m.from === myOidRef2.current) break;
          onIce(m.from, m.candidate);
          break;
        }
        case 'mp:error': {
          toast(m.error || 'Multiplayer error', 'error');
          break;
        }
        case 'mp:left':
        case 'mp:closed': {
          resetRoom();
          if (m.type === 'mp:closed') pushSys('This session has ended');
          break;
        }
      }
    };
    window.addEventListener('nova-ws', h);
    return () => window.removeEventListener('nova-ws', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Leave + cleanup when the panel unmounts / component unmounts */
  const stayInRoomRef = useRef(true);
  useEffect(() => {
    stayInRoomRef.current = true;
    return () => { stayInRoomRef.current = false; closeAllPcs(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!open) return null;

  const isHost = room && players.some((p) => p.oid === myOid && p.isHost);

  return (
    <div className="mp-backdrop" onClick={onClose}>
      <div className="mp-panel" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mp-header">
          <span className="mp-title"><i className="fa-solid fa-people-group" /> Collaborate</span>
          {room && <button className="mp-code-chip" onClick={copyInvite} title="Copy invite link"><i className="fa-solid fa-link" /> {room.id}</button>}
          {!room && <span className="mp-solo">Not in a room</span>}
          <button className="icon-btn" title="Close" onClick={onClose}><i className="fas fa-xmark" /></button>
        </div>

        <div className="mp-body">
          {!room ? (
            <div className="mp-create">
              {savedJoin && (
                <div className="mp-invite-note"><i className="fa-solid fa-envelope-open-text" /> You're invited to room <b>{savedJoin}</b></div>
              )}
              <label>Create a room</label>
              <div className="mp-row">
                <input value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="room name (optional)" maxLength={40} onKeyDown={(e) => e.key === 'Enter' && createRoom()} />
                <button className="btn btn-primary" onClick={createRoom}><i className="fas fa-plus" /> Create</button>
              </div>
              <div className="mp-or">or join with an invite code</div>
              <label>Invite code</label>
              <div className="mp-row">
                <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} placeholder="e.g. K3X9QA" maxLength={8} style={{ textTransform: 'uppercase' }} onKeyDown={(e) => e.key === 'Enter' && joinRoom()} />
                <button className="btn" onClick={joinRoom}><i className="fa-solid fa-right-to-bracket" /> Join</button>
              </div>
              <div className="mp-hint"><i className="fa-solid fa-circle-info" /> Share the invite code from a room with friends. Host approval can be toggled.</div>
            </div>
          ) : (
            <Fragment>
              <div className="mp-section-title">Players ({players.length})</div>
              <div className="mp-players">
                {players.map((p) => (
                  <div className="mp-player" key={p.oid}>
                    <span className="mp-avatar" style={{ background: p.color || '#8c93a8' }}>{String(p.name || '?')[0].toUpperCase()}</span>
                    <span className="mp-pname">
                      {p.name}{p.oid === myOid ? <em> (you)</em> : ''}{p.isHost && <i className="fa-solid fa-crown mp-host-crown" title="Host" />}
                    </span>
                    {p.mic && <i className="fa-solid fa-microphone mp-mic" title="Mic on" />}
                    {p.frozen && <i className="fa-solid fa-snowflake mp-frozen" title="Frozen by host" />}
                    <span className="mp-ms" title="Latency">{p.ms != null ? p.ms + 'ms' : '—'}</span>
                    {isHost && p.oid !== myOid && (
                      <span className="mp-actions">
                        <button className="icon-btn" title={p.frozen ? 'Unfreeze' : 'Freeze'} onClick={() => wsSend({ type: 'mp:freeze', oid: p.oid, frozen: !p.frozen })}><i className={`fa-solid ${p.frozen ? 'fa-snowman' : 'fa-snowflake'}`} /></button>
                        <button className="icon-btn" title="Kick player" onClick={() => wsSend({ type: 'mp:kick', oid: p.oid })}><i className="fa-solid fa-user-slash" /></button>
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {pending.length > 0 && (
                <Fragment>
                  <div className="mp-section-title">Join requests</div>
                  <div className="mp-players">
                    {pending.map((p) => (
                      <div className="mp-player" key={p.oid}>
                        <span className="mp-avatar" style={{ background: p.color || '#8c93a8' }}>{String(p.name || '?')[0].toUpperCase()}</span>
                        <span className="mp-pname">{p.name}</span>
                        {isHost ? (
                          <span className="mp-actions">
                            <button className="icon-btn approve" title="Approve" onClick={() => wsSend({ type: 'mp:approve', oid: p.oid })}><i className="fa-solid fa-check" /></button>
                            <button className="icon-btn deny" title="Deny" onClick={() => wsSend({ type: 'mp:deny', oid: p.oid })}><i className="fa-solid fa-xmark" /></button>
                          </span>
                        ) : <span className="mp-ms">waiting…</span>}
                      </div>
                    ))}
                  </div>
                </Fragment>
              )}

              {isHost && (
                <Fragment>
                  <div className="mp-section-title">Host tools</div>
                  <div className="mp-tools">
                    <button className={`btn ${room.requireApproval ? '' : 'btn-ghost'}`} onClick={() => wsSend({ type: 'mp:approval', on: !room.requireApproval })}>
                      <i className="fa-solid fa-user-check" /> Approval {room.requireApproval ? 'ON' : 'OFF'}
                    </button>
                    <button className="btn btn-danger" onClick={() => wsSend({ type: 'mp:stop' })}><i className="fa-solid fa-stop" /> End session</button>
                  </div>
                </Fragment>
              )}

              <div className="mp-chat">
                <div className="mp-section-title">Chat</div>
                <div className="mp-msgs" ref={chatScrollRef}>
                  {chat.map((c, i) => (
                    <div key={i} className={`mp-msg ${c.sys ? 'sys' : ''}`}>
                      {!c.sys && <span className="mp-msg-name" style={{ color: c.color || 'var(--text-muted)' }}>{c.name}:</span>}
                      <span>{c.text}</span>
                    </div>
                  ))}
                  {!chat.length && <div className="mp-chat-empty">No messages yet</div>}
                </div>
                <form className="mp-chat-form" onSubmit={(e) => { e.preventDefault(); sendChat(); }}>
                  <input value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="Say something…" maxLength={500} />
                  <button type="submit" className="icon-btn" title="Send"><i className="fa-solid fa-paper-plane" /></button>
                </form>
              </div>
            </Fragment>
          )}
        </div>

        {room && (
          <div className="mp-foot">
            <button className={`mp-mic-btn ${micOn ? 'on' : ''}`} onClick={toggleMic} disabled={voiceBusy} title={micOn ? 'Mute my microphone' : 'Unmute my microphone'}>
              {voiceBusy ? <span className="spinner inline" /> : <i className={`fa-solid ${micOn ? 'fa-microphone' : 'fa-microphone-slash'}`} />}
              {micOn ? ' Mute' : ' Talk'}
            </button>
            <span className="mp-voicepeers">
              {audioPeers.map((k) => {
                const p = players.find((x) => String(x.oid) === k);
                return p ? <span key={k} className="mp-voice-dot" style={{ background: p.color }} title={`${p.name} voice live`}><i className="fa-solid fa-volume-high" /></span> : null;
              })}
            </span>
<button className="icon-btn mp-leave" title="Leave room" onClick={leaveRoom}><i className="fa-solid fa-right-from-bracket" /> Leave</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   BOOT
   ============================================================ */
ReactDOM.createRoot(document.getElementById('root')).render(<App />);