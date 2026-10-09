// Sanskrit by default; en and hi on request. Sassembly's own syntax and the file's marker words are never translated.
const D = {
  sa: { run: 'चालय', runall: 'सर्वं चालय', open: 'उद्घाटय', save: 'रक्ष', new: 'नवम्', addcode: '+ कोष्ठः', addnote: '+ टिप्पणी', up: '↑', down: '↓', del: 'लोपय', kind: 'प्रकारः ⇄',
    code: 'कोष्ठः', note: 'टिप्पणी', running: 'चलति…', rerun: 'पुनश्चालितम्', saved: 'रक्षितम्', match: 'रक्षितेन समम्', mismatch: 'भेदः — रक्षितं पुनश्चालितं च भिन्नम्',
    pins: 'सूचना: एषा सञ्चिका अन्येन सङ्कलकबिम्बेन वा यन्त्रेण वा रक्षिता।', timeout: (s) => `${s} विनाडिकासु उत्तरं नास्ति; कर्मकः समाप्तः (मन्दं यन्त्रम्?)`,
    title: 'पुस्तिकानाम', examples: 'उदाहरणानि…', empty: 'कोष्ठाः न सन्ति।' },
  en: { run: 'Run', runall: 'Run all', open: 'Open', save: 'Save', new: 'New', addcode: '+ code', addnote: '+ note', up: '↑', down: '↓', del: 'Delete', kind: 'kind ⇄',
    code: 'code', note: 'note', running: 'running…', rerun: 'rerun', saved: 'saved', match: 'equals the saved output', mismatch: 'MISMATCH — the saved output differs from the rerun',
    pins: 'Note: this file was saved under a different compiler image or engine.', timeout: (s) => `slow device? no answer after ${s} s; the worker was terminated (a desktop needs about 10 s)`,
    title: 'Notebook title', examples: 'Examples…', empty: 'No cells.' },
  hi: { run: 'चलाएँ', runall: 'सब चलाएँ', open: 'खोलें', save: 'सहेजें', new: 'नया', addcode: '+ कोड', addnote: '+ टिप्पणी', up: '↑', down: '↓', del: 'हटाएँ', kind: 'प्रकार ⇄',
    code: 'कोड', note: 'टिप्पणी', running: 'चल रहा है…', rerun: 'पुनः चलाया', saved: 'सहेजा हुआ', match: 'सहेजे आउटपुट के बराबर', mismatch: 'अंतर — सहेजा आउटपुट और पुनः चलाया आउटपुट भिन्न हैं',
    pins: 'सूचना: यह फ़ाइल किसी अन्य कंपाइलर इमेज या इंजन से सहेजी गई थी।', timeout: (s) => `${s} सेकंड में उत्तर नहीं; कर्मक समाप्त (धीमा उपकरण?)`,
    title: 'नोटबुक का नाम', examples: 'उदाहरण…', empty: 'कोई कोष्ठ नहीं।' },
};
let lang = 'sa'; try { const s = localStorage.getItem('brihaspati-lang'); if (D[s]) lang = s; } catch {}
export const LANG = () => lang;
export const setLang = (l) => { if (D[l]) { lang = l; try { localStorage.setItem('brihaspati-lang', l); } catch {} } };
export const t = (k, ...a) => { const v = D[lang][k] ?? D.sa[k] ?? k; return typeof v === 'function' ? v(...a) : v; };
