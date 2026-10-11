// HTML for MemberDesk. Deliberately written like a 2004 enterprise app:
// framesets, tables nested three deep for layout, <font> tags, no ids, no
// meaningful classes, no ARIA, no <label for>, opaque field names (f1, f2).
// The label for an input is plain text in the neighbouring table cell. That is
// the hostility the automation has to cope with.

import type { TenantConfig } from './tenants.js';

export function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A bare HTML document. Used for frames and for pages outside the frameset. */
export function doc(title: string, body: string, bgcolor = '#eeeeee'): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html><head><title>${esc(title)}</title>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>
<body bgcolor="${bgcolor}" marginwidth="4" marginheight="4">
${body}
</body></html>`;
}

/**
 * A page for the main frame. Content sits inside three levels of layout
 * tables, with the product footer below it.
 */
export function page(tenant: TenantConfig, title: string, content: string): string {
  return doc(
    title,
    `<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>
  <table width="100%" cellpadding="2" cellspacing="0" border="0"><tr><td valign="top">
    <table width="96%" cellpadding="4" cellspacing="0" border="0" bgcolor="#ffffff"><tr><td>
      <font face="Arial" size="3" color="#003366"><b>${esc(title)}</b></font>
      <hr size="1" noshade>
      ${content}
    </td></tr></table>
  </td></tr></table>
</td></tr>
<tr><td><br><font face="Arial" size="1" color="#666666">MemberDesk v${esc(tenant.productVersion)} &middot; ${esc(tenant.institution)}</font></td></tr>
</table>`,
  );
}

/** A red message line, as legacy apps show validation and errors. */
export function message(text: string): string {
  return `<table cellpadding="2" cellspacing="0" border="0"><tr><td><font face="Arial" size="2" color="#cc0000"><b>${esc(text)}</b></font></td></tr></table>`;
}

export interface FieldRow {
  label: string;
  input: string;
}

/** A form grid: label text in one cell, the bare input in the next. */
export function fieldGrid(rows: FieldRow[]): string {
  const trs = rows
    .map(
      (r) =>
        `<tr><td align="right" nowrap><font face="Arial" size="2">${esc(r.label)}</font></td><td>${r.input}</td></tr>`,
    )
    .join('\n');
  return `<table cellpadding="3" cellspacing="0" border="0">${trs}</table>`;
}

export function textInput(name: string, value = '', size = 20, type = 'text'): string {
  return `<input type="${type}" name="${name}" value="${esc(value)}" size="${size}">`;
}

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${esc(value)}">`;
}

export function submit(label: string): string {
  return `<input type="submit" value="${esc(label)}">`;
}

export function select(name: string, options: readonly string[], selected?: string): string {
  const opts = options
    .map((o) => `<option value="${esc(o)}"${o === selected ? ' selected' : ''}>${esc(o)}</option>`)
    .join('');
  return `<select name="${name}"><option value="">-- select --</option>${opts}</select>`;
}

export function frameset(tenant: TenantConfig): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html><head><title>MemberDesk - ${esc(tenant.institution)}</title></head>
<frameset rows="64,*" border="1">
  <frame src="/app/banner" name="banner" scrolling="no" noresize>
  <frameset cols="180,*">
    <frame src="/app/nav" name="nav">
    <frame src="/app/main" name="main">
  </frameset>
</frameset>
</html>`;
}
