/** A faithful recreation of cgit's default stylesheet (cgit.css). */
export const CSS = `
div#cgit {
  padding: 0em;
  margin: 0em;
  font-family: sans-serif;
  font-size: 10pt;
  color: #333;
  background: white;
  padding: 4px;
}
div#cgit a {
  color: blue;
  text-decoration: none;
}
div#cgit a:hover {
  text-decoration: underline;
}
div#cgit table {
  border-collapse: collapse;
}
div#cgit table#header {
  width: 100%;
  margin-bottom: 1em;
}
div#cgit table#header td.logo {
  width: 96px;
  vertical-align: top;
}
div#cgit table#header td.main {
  font-size: 250%;
  padding-left: 10px;
  white-space: nowrap;
}
div#cgit table#header td.main a {
  color: #000;
}
div#cgit table#header td.form {
  text-align: right;
  vertical-align: bottom;
  padding-right: 1em;
  padding-bottom: 2px;
  white-space: nowrap;
}
div#cgit table#header td.sub {
  color: #777;
  border-top: solid 1px #ccc;
  padding-left: 10px;
}
div#cgit table.tabs {
  border-bottom: solid 3px #ccc;
  border-collapse: collapse;
  margin-top: 2em;
  margin-bottom: 0px;
  width: 100%;
}
div#cgit table.tabs td {
  padding: 0px 1em;
  vertical-align: bottom;
}
div#cgit table.tabs td a {
  padding: 2px 0.75em;
  color: #777;
  font-size: 110%;
}
div#cgit table.tabs td a.active {
  color: #000;
  background-color: #ccc;
}
div#cgit table.tabs a[href]:hover {
  text-decoration: none;
}
div#cgit table.tabs td.form {
  text-align: right;
}
div#cgit table.tabs td.form form {
  padding-bottom: 2px;
  font-size: 90%;
  white-space: nowrap;
}
div#cgit div.path {
  margin: 0px;
  padding: 5px 2em 2px 2em;
  color: #000;
  background-color: #eee;
}
div#cgit div.content {
  margin: 0px;
  padding: 2em;
  border-bottom: solid 3px #ccc;
}
div#cgit table.list {
  width: 100%;
  border: none;
  border-collapse: collapse;
}
div#cgit table.list tr {
  background: white;
}
div#cgit table.list tr.logheader {
  background: #eee;
}
div#cgit table.list tr:hover {
  background: #eee;
}
div#cgit table.list tr.nohover, div#cgit table.list tr.nohover:hover {
  background: white;
}
div#cgit table.list th {
  font-weight: bold;
  border-top: dashed 1px #888;
  border-bottom: dashed 1px #888;
  padding: 0.1em 0.5em 0.05em 0.5em;
  vertical-align: baseline;
  text-align: left;
}
div#cgit table.list td {
  border: none;
  padding: 0.1em 0.5em 0.1em 0.5em;
}
div#cgit table.list td.commitgraph {
  font-family: monospace;
  white-space: pre;
}
div#cgit table.list td.logsubject {
  font-family: monospace;
  font-weight: bold;
}
div#cgit table.list td.logmsg {
  font-family: monospace;
  white-space: pre;
  padding: 0 0.5em;
}
div#cgit table.list td a {
  color: black;
}
div#cgit table.list td a.ls-dir {
  font-weight: bold;
  color: #00f;
}
div#cgit table.list td a:hover {
  color: #00f;
}
div#cgit td.ls-size {
  text-align: right;
  font-family: monospace;
  width: 10em;
}
div#cgit td.ls-mode {
  font-family: monospace;
  width: 10em;
}
div#cgit table.blob {
  margin-top: 0.5em;
  border-top: solid 1px black;
}
div#cgit table.blob td.linenumbers {
  margin: 0;
  padding: 0 0 0 0.5em;
  vertical-align: top;
  text-align: right;
  border-right: 1px solid gray;
}
div#cgit table.blob pre {
  padding: 0;
  margin: 0;
}
div#cgit table.blob td.linenumbers a {
  color: gray;
  text-align: right;
  font-family: monospace;
}
div#cgit table.blob td.lines {
  margin: 0;
  padding: 0 0 0 0.5em;
  vertical-align: top;
}
div#cgit table.blob td.lines pre, div#cgit td.lines code {
  font-family: monospace;
}
div#cgit div.footer {
  margin-top: 0.5em;
  text-align: center;
  font-size: 80%;
  color: #ccc;
}
div#cgit div.footer a {
  color: #ccc;
  text-decoration: none;
}
div#cgit div.footer a:hover {
  text-decoration: underline;
}
div#cgit table.commit-info {
  border-collapse: collapse;
  margin-top: 1.5em;
}
div#cgit table.commit-info th {
  text-align: left;
  font-weight: normal;
  padding: 0.1em 1em 0.1em 0.1em;
  vertical-align: top;
}
div#cgit table.commit-info td {
  font-weight: normal;
  padding: 0.1em 1em 0.1em 0.1em;
}
div#cgit div.commit-subject {
  font-weight: bold;
  font-size: 125%;
  margin: 1.5em 0em 0.5em 0em;
  padding: 0em;
}
div#cgit div.commit-msg {
  white-space: pre;
  font-family: monospace;
}
div#cgit div.diffstat-header {
  font-weight: bold;
  padding-top: 1.5em;
}
div#cgit table.diffstat {
  border-collapse: collapse;
  border: solid 1px #aaa;
  background-color: #eee;
}
div#cgit table.diffstat th {
  font-weight: normal;
  text-align: left;
  text-decoration: underline;
  padding: 0.1em 1em 0.1em 0.1em;
  font-size: 100%;
}
div#cgit table.diffstat td {
  padding: 0.2em 0.2em 0.1em 0.1em;
  font-size: 100%;
  border: none;
}
div#cgit table.diffstat td span.modechange {
  padding-left: 1em;
  color: red;
}
div#cgit table.diffstat td.add a {
  color: green;
}
div#cgit table.diffstat td.del a {
  color: red;
}
div#cgit table.diffstat td.graph {
  width: 500px;
  vertical-align: middle;
}
div#cgit table.diffstat td.graph table {
  border: none;
}
div#cgit table.diffstat td.graph td {
  padding: 0px;
  border: 0px;
  height: 7pt;
}
div#cgit table.diffstat td.graph td.add {
  background-color: #5c5;
}
div#cgit table.diffstat td.graph td.rem {
  background-color: #c55;
}
div#cgit div.diffstat-summary {
  color: #888;
  padding-top: 0.5em;
}
div#cgit table.diff {
  width: 100%;
}
div#cgit table.diff td {
  font-family: monospace;
  white-space: pre-wrap;
}
div#cgit table.diff td div.head {
  font-weight: bold;
  margin-top: 1em;
  color: black;
}
div#cgit table.diff td div.hunk {
  color: #009;
}
div#cgit table.diff td div.add {
  color: green;
}
div#cgit table.diff td div.del {
  color: red;
}
div#cgit .sha1 {
  font-family: monospace;
  font-size: 90%;
}
div#cgit .left {
  text-align: left;
}
div#cgit .right {
  text-align: right;
}
div#cgit table.list td.reposection {
  font-style: italic;
  color: #888;
}
div#cgit a.branch-deco {
  color: #000;
  margin: 0px 0.5em;
  padding: 0px 0.25em;
  background-color: #88ff88;
  border: solid 1px #007700;
}
div#cgit a.tag-deco {
  color: #000;
  margin: 0px 0.5em;
  padding: 0px 0.25em;
  background-color: #ffff88;
  border: solid 1px #777700;
}
div#cgit a.deco {
  color: #000;
  margin: 0px 0.5em;
  padding: 0px 0.25em;
  background-color: #ff8888;
  border: solid 1px #770000;
}
div#cgit span.age-mins {
  font-size: 90%;
  color: #080;
}
div#cgit span.age-hours {
  font-size: 90%;
  color: #080;
}
div#cgit span.age-days {
  font-size: 90%;
  color: #040;
}
div#cgit span.age-weeks {
  font-size: 90%;
  color: #444;
}
div#cgit span.age-months {
  font-size: 90%;
  color: #888;
}
div#cgit span.age-years {
  font-size: 90%;
  color: #bbb;
}
div#cgit div.error {
  color: red;
  font-weight: bold;
  margin: 1em 2em;
}
div#cgit table.repolist-clone td {
  padding-right: 1em;
}
div#cgit .clone-url {
  font-family: monospace;
}
div#cgit span.hl-c { color: #888; font-style: italic; }
div#cgit span.hl-s { color: #a11; }
div#cgit span.hl-k { color: #00d; }
div#cgit span.hl-n { color: #099; }
div#cgit table.blame td.sha1 {
  white-space: nowrap;
  vertical-align: top;
  padding-right: 1em;
}
div#cgit table.blame td.lines {
  vertical-align: top;
}
div#cgit table.blame tr:hover {
  background: #eee;
}
div#cgit table.blame pre {
  margin: 0;
  padding: 0;
}
div#cgit div.md h1, div#cgit div.md h2 {
  border-bottom: solid 1px #ccc;
  padding-bottom: 0.2em;
}
div#cgit div.md pre.md-code {
  background: #f4f4f4;
  border: solid 1px #ddd;
  padding: 0.5em;
  overflow-x: auto;
}
div#cgit div.md code {
  background: #f4f4f4;
  padding: 0 0.2em;
}
div#cgit div.md blockquote {
  border-left: solid 3px #ccc;
  margin-left: 0;
  padding-left: 1em;
  color: #666;
}
div#cgit table.stats th {
  text-align: left;
  padding: 0.1em 0.5em;
  border-top: dashed 1px #888;
  border-bottom: dashed 1px #888;
}
div#cgit table.stats td {
  text-align: right;
  padding: 0.1em 0.5em;
}
div#cgit table.stats td.name {
  text-align: left;
}
div#cgit table.list td.snapshots a {
  margin-right: 0.5em;
}
div#cgit form select, div#cgit form input {
  font-size: 90%;
}
`;
