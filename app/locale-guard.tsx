"use client";

import { useEffect } from "react";
import { dedupeAdjacentEnglish, localizeText } from "./i18n-runtime";

const ignoredTags = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "INPUT", "TEXTAREA"]);
const translatedAttributes = ["aria-label", "placeholder", "title", "alt"] as const;

type RenderedText = { source: string; rendered: string };

// Keep the original source string for every node. React may re-use a text
// node after the user switches language, so translating the current DOM value
// would otherwise translate an already-translated word and make it impossible
// to switch back cleanly.
const textSources = new WeakMap<Text, RenderedText>();
const attributeSources = new WeakMap<HTMLElement, Map<string, RenderedText>>();

/**
 * A route-level safety net for the independently rendered panels in the app.
 * It runs after hydration, so it also covers portal content, select options,
 * toast messages and API errors that are added after the initial render.
 */
export default function LocaleGuard() {
  useEffect(() => {
    let busy = false;

    const clean = () => {
      const locale = document.documentElement.lang || navigator.language || "en-US";
      if (busy) return;
      busy = true;
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const textNodes: Text[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (parent && !ignoredTags.has(parent.tagName)) textNodes.push(node as Text);
        }
        for (const textNode of textNodes) {
          const current = textNode.nodeValue || "";
          const known = textSources.get(textNode);
          // A value different from the last value we rendered means React (or
          // a user action) supplied a new source string; otherwise retain the
          // original Chinese source while switching between locales.
          const source = !known || current !== known.rendered ? current : known.source;
          const next = localizeText(source, locale);
          textSources.set(textNode, { source, rendered: next });
          if (next !== current) textNode.nodeValue = next;
        }

        for (const element of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
          if (ignoredTags.has(element.tagName)) continue;
          for (const attribute of translatedAttributes) {
            const current = element.getAttribute(attribute);
            if (!current) continue;
            const records = attributeSources.get(element) || new Map<string, RenderedText>();
            const known = records.get(attribute);
            const source = !known || current !== known.rendered ? current : known.source;
            const next = localizeText(source, locale);
            records.set(attribute, { source, rendered: next });
            attributeSources.set(element, records);
            if (next !== current) element.setAttribute(attribute, next);
          }

          // Some panels render a translated label and its fallback as adjacent
          // sibling elements. Remove the second copy only when it is a plain
          // text node, keeping icons, links and controls intact.
          const children = Array.from(element.children) as HTMLElement[];
          for (let index = 1; index < children.length; index += 1) {
            const previous = children[index - 1];
            const current = children[index];
            if (current.childElementCount > 0) continue;
            const previousText = previous.textContent?.trim() || "";
            const currentText = current.textContent?.trim() || "";
            if (previousText && currentText && dedupeAdjacentEnglish(`${previousText} ${currentText}`) === previousText) {
              current.textContent = "";
            }
          }
        }
      } finally {
        busy = false;
      }
    };

    clean();
    const observer = new MutationObserver(clean);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "placeholder", "title", "alt"],
    });
    const languageObserver = new MutationObserver(clean);
    languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => {
      observer.disconnect();
      languageObserver.disconnect();
    };
  }, []);

  return null;
}
