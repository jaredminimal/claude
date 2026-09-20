// A stand-in FetLife: kinksters pages in the real member-card DOM shape,
// /activity endpoints in the documented JSON shape, and a CDN that refuses
// requests arriving without a Referer - which is hard-won fact #9.
import zlib from 'zlib';

export const PROFILES = [];
const GENDERS = ['F','M','TW','NB'];   // the codes FetLife actually prints
const ROLES = ['Submissive','Dominant','Switch','Kinkster'];
const CITY = ['Phoenix','Scottsdale','Tempe'];
for (let i = 0; i < 24; i++) {
  PROFILES.push({
    nick: 'member' + i,
    age: 22 + (i % 30),
    gender: GENDERS[i % 4],
    role: ROLES[i % 4],
    city: CITY[i % 3],
    attachment: 100000 + i,          // distinct picture per person
  });
}
// Special cases, appended so they land on the last page.
PROFILES[3].behaviour  = '404';      // deleted or renamed
PROFILES[7].behaviour  = '403';      // private feed
PROFILES[11].behaviour = 'html';     // /activity answers with markup, not JSON
PROFILES[15].behaviour = 'nopic';    // no picture anywhere
PROFILES[19].behaviour = 'stale';    // active, but long ago

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();
export function lastActivityFor(p) {
  if (p.behaviour === 'stale') return daysAgo(300);
  return daysAgo(3 + (Number(p.nick.replace('member','')) % 20));
}

// A real, valid JPEG, made unique per person by a COM segment carrying their
// name - so "is this the right person's face?" is answerable from the bytes.
const BASE_JPEG = Buffer.from(
 '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
export function jpegFor(name) {
  const tag = Buffer.from('ASL-TEST:' + name, 'latin1');
  const len = Buffer.alloc(2); len.writeUInt16BE(tag.length + 2);
  return Buffer.concat([BASE_JPEG.subarray(0, 2),                 // SOI
                        Buffer.from([0xFF, 0xFE]), len, tag,      // COM
                        BASE_JPEG.subarray(2)]);
}
export const picUrl = (p, size) =>
  `https://picav2-c${size}.cdn.fetlife.com/picture/attachments/${p.attachment}/a${size}.jpg?1758000000-abc${p.attachment}`;

const PER_PAGE = 8;
export function kinkstersPage(n) {
  const slice = PROFILES.slice((n - 1) * PER_PAGE, n * PER_PAGE);
  const cards = slice.map(p => `
    <div data-member-card="${p.nick}">
      <a href="/${p.nick}"><img src="${p.behaviour === 'nopic' ? '' : picUrl(p, 160)}" alt=""></a>
      <a href="/${p.nick}">${p.nick}</a>
      <span>${p.age}${p.gender} ${p.role}</span>
      <a href="/p/united-states/arizona/${p.city.toLowerCase()}">${p.city}</a>
    </div>`).join('\n');
  // The logged-in user's own avatar sits in the header of every page.
  return `<!doctype html><html><head><title>Kinksters</title></head><body>
    <header><img src="https://picav2-c50.cdn.fetlife.com/picture/attachments/999999/a50.jpg?1758000000-me" alt="you"></header>
    <main>${slice.length ? cards : '<p>No members found.</p>'}</main></body></html>`;
}

export function activityJson(p) {
  return JSON.stringify({ story_groups: [ { stories: [
    { created_at: lastActivityFor(p),
      author: { nickname: p.nick,
                avatar_url: p.behaviour === 'nopic' ? null : picUrl(p, 400),
                profile_url: 'https://fetlife.com/' + p.nick } } ] } ] });
}
export function activityHtml(p) {
  return `<!doctype html><html><body>
    <header><img src="https://picav2-c50.cdn.fetlife.com/picture/attachments/999999/a50.jpg?1758000000-me"></header>
    <div class="story"><time datetime="${lastActivityFor(p)}">recently</time></div>
    <img src="${picUrl(p, 400)}" alt="${p.nick}"></body></html>`;
}
export function profilePage(p) {
  return `<!doctype html><html><head>
    <meta property="og:image" content="https://fetlife.com/assets/logo/og-image-1.png">
    </head><body>
    <header><img src="https://picav2-c50.cdn.fetlife.com/picture/attachments/999999/a50.jpg?1758000000-me"></header>
    <img src="${picUrl(p, 400)}" alt="${p.nick}"></body></html>`;
}
export const byNick = n => PROFILES.find(p => p.nick === n);
