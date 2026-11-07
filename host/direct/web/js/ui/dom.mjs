// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026 Ji Dong

// @ts-check
/** @file Cache required DOM elements per document; no board or protocol access. */

/** @type {WeakMap<Document, Map<string, HTMLElement>>} */
const elementsByRoot = new WeakMap();

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @overload
 * @param {`${K}#${string}`} selector
 * @param {Document} [root]
 * @return {HTMLElementTagNameMap[K]}
 */
/**
 * @overload
 * @param {string} selector
 * @param {Document} [root]
 * @return {HTMLElement}
 */
/**
 * @param {string} selector
 * @param {Document} [root]
 * @return {HTMLElement}
 */
export function queryElement(selector, root = document) {
  let elements = elementsByRoot.get(root);
  if (!elements) elementsByRoot.set(root, elements = new Map());
  const cached = elements.get(selector);
  if (cached) return cached;
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Required dashboard element not found: ${selector}`);
  if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") {
    throw new Error(`Required dashboard element is not HTML: ${selector}`);
  }
  const tag = selector.match(/^([a-z][a-z0-9]*)#/i)?.[1].toLowerCase();
  if (tag && element.localName !== tag) {
    throw new Error(`Required dashboard element has the wrong tag: ${selector}`);
  }
  const html = /** @type {HTMLElement} */ (element);
  elements.set(selector, html);
  return html;
}

/**
 * @param {Record<string, unknown>} values Element id to text.
 * @param {Document} [root]
 */
export function setText(values, root = document) {
  for (const [id, value] of Object.entries(values)) {
    const element = queryElement(`#${id}`, root);
    const text = value == null ? "" : String(value);
    if (element.textContent !== text) element.textContent = text;
  }
}

/**
 * @param {HTMLElement} element
 * @param {string} message
 * @param {boolean} [error]
 */
export function setStatus(element, message, error = false) {
  element.textContent = message;
  element.dataset.error = String(error);
}
