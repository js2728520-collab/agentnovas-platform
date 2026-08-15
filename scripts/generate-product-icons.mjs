import { readdir, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  siApple,
  siTesla,
  siNvidia,
  siMeta,
  siGoogle,
  siAmd,
  siNetflix,
} from "simple-icons";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(projectRoot, "public", "product-icons");
const web3IconRoot = path.join(projectRoot, "node_modules", "@web3icons", "core", "dist", "svgs", "tokens", "branded");

const escapeXml = (value) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
const wrapPath = (icon, fill = `#${icon.hex}`) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img"><title>${escapeXml(icon.title)}</title><path fill="${fill}" d="${icon.path}"/></svg>`;

const tonIcon = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" role="img"><title>Toncoin</title><path fill="#0098EA" d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0ZM7.902 6.697h8.196c1.505 0 2.462 1.628 1.705 2.94l-5.059 8.765a.86.86 0 0 1-1.488 0L6.199 9.637c-.758-1.314.197-2.94 1.703-2.94Zm4.844 1.496v7.58l1.102-2.128 2.656-4.756a.465.465 0 0 0-.408-.696h-3.35Zm-.002 0H7.9a.464.464 0 0 0-.408.694l2.658 4.754 1.102 2.13V8.195Z"/></svg>';

const currencyStyle = {
  USD: ["#1f8f58", "$"], EUR: ["#2457b2", "€"], GBP: ["#7a3fa0", "£"], JPY: ["#d94a4a", "¥"],
  AUD: ["#087e8b", "A$"], CAD: ["#ca3433", "C$"], CHF: ["#c92d39", "Fr"], NZD: ["#174c88", "N$"],
  CNY: ["#df2638", "¥"], HKD: ["#c52655", "H$"], SGD: ["#d04b45", "S$"],
};

function currencyPairSvg(base, quote) {
  const [baseColor, baseGlyph] = currencyStyle[base];
  const [quoteColor, quoteGlyph] = currencyStyle[quote];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 28" role="img"><title>${base}/${quote}</title><circle cx="17" cy="14" r="12" fill="${baseColor}" stroke="#dbe8f5" stroke-width="1.5"/><circle cx="31" cy="14" r="12" fill="${quoteColor}" stroke="#dbe8f5" stroke-width="1.5"/><text x="14" y="17.5" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="8" font-weight="700">${escapeXml(baseGlyph)}</text><text x="34" y="17.5" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="8" font-weight="700">${escapeXml(quoteGlyph)}</text></svg>`;
}

function metalSvg(symbol, name, color, accent) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img"><title>${name}</title><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${accent}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs><circle cx="16" cy="16" r="14" fill="url(#g)" stroke="#fff" stroke-opacity=".55"/><circle cx="16" cy="16" r="10.5" fill="none" stroke="#fff" stroke-opacity=".4"/><text x="16" y="20" text-anchor="middle" fill="#101820" font-family="Georgia,serif" font-size="11" font-weight="700">${symbol}</text></svg>`;
}

const microsoftIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img"><title>Microsoft</title><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M13 1h10v10H13z"/><path fill="#00a4ef" d="M1 13h10v10H1z"/><path fill="#ffb900" d="M13 13h10v10H13z"/></svg>';
const amazonIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" role="img"><title>Amazon</title><path fill="#fff" d="M27.8 27.7c-2.8 2.1-6.8 3.2-10.2 3.2-4.8 0-9.2-1.8-12.5-4.8-.3-.2 0-.6.3-.4 3.6 2.1 8.1 3.4 12.7 3.4 3 0 6.4-.6 9.5-1.9.5-.2.8.3.2.5Z"/><path fill="#ff9900" d="M30.8 25.4c-.4-.5-2.4-.2-3.3-.1-.3 0-.3-.2-.1-.4 1.7-1.2 4.5-.9 4.9-.5.3.4-.1 3.2-1.7 4.5-.2.2-.5.1-.4-.2.4-.9 1-2.8.6-3.3Z"/><path fill="#fff" d="M25.2 22.3c0 1 .1 1.8.4 2.4.1.3.4.5.7.6l2.1 1.9c.2.2.2.5 0 .7l-2.5 2.1c-.3.2-.7.3-1 0-.8-.7-1.4-1.5-1.9-2.5-1.8 1.9-4.5 3-7 3-3.6 0-6.4-2.2-6.4-6.5 0-3.4 1.8-5.7 4.4-6.8 2.3-1 5.4-1.2 7.8-1.5v-.5c0-.9.1-2-.5-2.8-.5-.7-1.4-1-2.3-1-1.6 0-3 .8-3.3 2.4-.1.4-.4.7-.8.7l-4.2-.4c-.4-.1-.8-.4-.7-.9C11 8.1 15.4 6.6 19.3 6.6c2 0 4.6.5 6.2 2 2 1.9 1.8 4.4 1.8 7.1v6.6h-2.1Zm-3.4-2.3c-2.1 0-4.3.4-4.3 2.9 0 1.3.7 2.2 1.9 2.2.9 0 1.7-.6 2.2-1.5.6-1.1.5-2.2.5-3.6h-.3Z"/></svg>';

await Promise.all(["crypto", "forex", "metals", "stocks"].map(folder => mkdir(path.join(outputRoot, folder), { recursive: true })));

const cryptoFiles = (await readdir(web3IconRoot)).filter(file => file.endsWith(".svg.js"));
await Promise.all(cryptoFiles.map(async file => {
  const module = await import(pathToFileURL(path.join(web3IconRoot, file)).href);
  const symbol = file.slice(0, -7).toUpperCase();
  await writeFile(path.join(outputRoot, "crypto", `${symbol}.svg`), module.default, "utf8");
}));
await writeFile(path.join(outputRoot, "crypto", "TON.svg"), tonIcon, "utf8");

const currencies = Object.keys(currencyStyle);
await Promise.all(currencies.flatMap(base => currencies.filter(quote => quote !== base).map(quote => writeFile(path.join(outputRoot, "forex", `${base}${quote}.svg`), currencyPairSvg(base, quote), "utf8"))));

const metals = {
  XAU: metalSvg("Au", "Gold", "#b47a09", "#ffe18a"),
  XAG: metalSvg("Ag", "Silver", "#7d8996", "#f5f8fb"),
  XPT: metalSvg("Pt", "Platinum", "#718293", "#e2edf4"),
  XPD: metalSvg("Pd", "Palladium", "#68778a", "#d7e1ec"),
};
await Promise.all(Object.entries(metals).map(([symbol, svg]) => writeFile(path.join(outputRoot, "metals", `${symbol}.svg`), svg, "utf8")));

const stockIcons = {
  AAPL: wrapPath(siApple, "#f5f5f7"), TSLA: wrapPath(siTesla), NVDA: wrapPath(siNvidia),
  MSFT: microsoftIcon, AMZN: amazonIcon, META: wrapPath(siMeta), GOOGL: wrapPath(siGoogle),
  GOOG: wrapPath(siGoogle), AMD: wrapPath(siAmd), NFLX: wrapPath(siNetflix),
};
await Promise.all(Object.entries(stockIcons).map(([symbol, svg]) => writeFile(path.join(outputRoot, "stocks", `${symbol}.svg`), svg, "utf8")));

const manifest = {
  crypto: cryptoFiles.length + 1,
  forex: currencies.length * (currencies.length - 1),
  metals: Object.keys(metals).length,
  stocks: Object.keys(stockIcons).length,
};
await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Generated ${manifest.crypto + manifest.forex + manifest.metals + manifest.stocks} local product icons.`);
