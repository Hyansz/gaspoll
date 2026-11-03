'use strict';

function paginateViewLines(lines, pageSize) {
  if (lines.length <= pageSize) return [lines];
  const pages = [];
  let cur = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isHeading = /[:]$/.test(l.trim()) || (/^[A-Z0-9\s\-"]+$/.test(l.trim()) && l.trim().length > 0 && l.trim().length < 50);
    if (cur.length >= pageSize) {
      pages.push(cur);
      cur = [l];
      continue;
    }
    if (isHeading && (pageSize - cur.length) < 4) {
      if (cur.length > 0) {
        pages.push(cur);
        cur = [];
      }
    }
    cur.push(l);
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

module.exports = { paginateViewLines };
