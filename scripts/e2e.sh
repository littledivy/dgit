#!/bin/bash
# cdgit end-to-end suite. Usage: e2e.sh <base-url> <token>
BASE=${1:-http://127.0.0.1:8787}
TOKEN=${2:-devtoken}
HOSTPORT=${BASE#http://}; HOSTPORT=${HOSTPORT#https://}
AUTH_BASE=$(echo "$BASE" | sed "s|://|://x:$TOKEN@|")
DIR=$(mktemp -d /tmp/cgit-e2e.XXXXXX)
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 (got '$1' want '$2')"; fi }

cd "$DIR"
export GIT_TERMINAL_PROMPT=0
GITC="git -c credential.helper= -c advice.detachedHead=false"

echo "== setup: source repo with history, tags, binary, symlink =="
git init -q -b main src && cd src
git config user.email dev@example.com && git config user.name "Dev One"
cat > README.md <<'EOF'
# demo project

A **demo** for `cdgit`.

- clone it
- push it

```js
const x = 1;
```
EOF
mkdir -p lib docs
printf 'export function add(a, b) {\n  return a + b;\n}\n' > lib/math.js
printf 'hello docs\n' > docs/guide.txt
ln -s lib/math.js mathlink.js
git add -A && git commit -qm "initial commit"
printf 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n' > lib/math.js
git add -A && git commit -qm "add mul function" --author="Dev Two <two@example.com>"
head -c 2500000 /dev/urandom > big.bin
git add -A && git commit -qm "add binary asset"
git tag -a v1.0 -m "release one point oh"
git tag lightweight-tag
for i in 1 2 3 4 5; do echo "line $i" >> docs/guide.txt; git add -A; git commit -qm "guide update $i"; done
cd "$DIR"

# clean slate for repeat runs
curl -s -o /dev/null -X DELETE -u "x:$TOKEN" "$BASE/demo"
curl -s -o /dev/null -X DELETE -u "x:$TOKEN" "$BASE/private-repo"

echo "== 1. push =="
(cd src && $GITC push -q "$AUTH_BASE/demo.git" main --tags); check $? 0 "initial push"

echo "== 2. full clone + fsck + content =="
$GITC clone -q "$BASE/demo.git" full 2>/dev/null; check $? 0 "clone"
(cd full && git fsck --strict > /dev/null 2>&1); check $? 0 "fsck --strict"
diff -r --exclude=.git src full > /dev/null; check $? 0 "content identical"
check "$(cd full && git tag | tr '\n' ' ')" "$(cd src && git tag | tr '\n' ' ')" "tags match"

echo "== 3. shallow clone =="
$GITC clone -q --depth 1 "$BASE/demo.git" shallow 2>/dev/null; check $? 0 "clone --depth 1"
check "$(cd shallow && git log --oneline 2>/dev/null | wc -l | tr -d ' ')" "1" "shallow has 1 commit"
(cd shallow && test -f .git/shallow); check $? 0 ".git/shallow exists"
(cd shallow && $GITC fetch -q --depth 3 2>/dev/null); check $? 0 "deepen to 3"
check "$(cd shallow && git log --oneline | wc -l | tr -d ' ')" "3" "deepened to 3 commits"
(cd shallow && $GITC fetch -q --unshallow 2>/dev/null); check $? 0 "unshallow"
check "$(cd shallow && git log --oneline | wc -l | tr -d ' ')" "$(cd src && git log --oneline | wc -l | tr -d ' ')" "unshallow = full history"
(cd shallow && git fsck > /dev/null 2>&1); check $? 0 "fsck after unshallow"

echo "== 4. incremental fetch is small =="
(cd src && echo "tweak" >> README.md && git add -A && git commit -qm "small tweak" && $GITC push -q "$AUTH_BASE/demo.git" main)
out=$(cd full && $GITC fetch origin 2>&1)
objs=$(echo "$out" | grep -o "Enumerating objects: [0-9]*" | grep -o "[0-9]*")
if [ -n "$objs" ] && [ "$objs" -le 5 ]; then ok "incremental fetch sent $objs objects (not whole repo)"; else fail "incremental fetch sent '$objs' objects"; fi
(cd full && $GITC merge -q --ff-only origin/main && git fsck > /dev/null 2>&1); check $? 0 "merged + fsck"

echo "== 5. sideband progress =="
prog=$($GITC clone "$BASE/demo.git" progress-test 2>&1 | grep -c "remote:"); rm -rf progress-test
if [ "$prog" -ge 1 ]; then ok "server progress shown via sideband"; else fail "no sideband progress"; fi

echo "== 6. force push + gc =="
(cd src && git commit -q --amend -m "small tweak (rewritten)" && $GITC push -q --force "$AUTH_BASE/demo.git" main); check $? 0 "force push"
gc=""
for attempt in 1 2 3; do
  gc=$(curl -s -X POST -u "x:$TOKEN" "$BASE/demo/gc")
  echo "$gc" | grep -q '"removed"' && break
  sleep 3  # celld may still be proving durability of the push burst
done
echo "  gc says: $gc"
echo "$gc" | grep -q '"removed":[1-9]'; check $? 0 "gc removed stranded objects"
$GITC clone -q "$BASE/demo.git" post-gc 2>/dev/null && (cd post-gc && git fsck > /dev/null 2>&1); check $? 0 "clone+fsck after gc"

echo "== 7. branch create/delete, non-ff rejection =="
(cd src && git checkout -qb feature && echo f > f.txt && git add -A && git commit -qm "feature work" && $GITC push -q "$AUTH_BASE/demo.git" feature && git checkout -q main); check $? 0 "branch push"
(cd src && $GITC push -q "$AUTH_BASE/demo.git" :feature); check $? 0 "branch delete"
(cd full && git commit -q --allow-empty -m "diverge" && $GITC push -q "$AUTH_BASE/demo.git" main > /dev/null 2>&1); check $? 1 "non-ff push rejected"
(cd full && git reset -q --hard origin/main)

echo "== 8. snapshots =="
curl -s -o snap.tar.gz "$BASE/demo/snapshot/demo-v1.0.tar.gz"
mkdir -p snap && tar xzf snap.tar.gz -C snap; check $? 0 "tar.gz extracts"
(cd src && git checkout -q v1.0 && diff -r --exclude=.git . "$DIR/snap/demo-v1.0" > /dev/null; r=$?; git checkout -q main; exit $r); check $? 0 "tar.gz content matches v1.0"
test -L snap/demo-v1.0/mathlink.js; check $? 0 "symlink preserved in tar"
curl -s -o snap.zip "$BASE/demo/snapshot/demo-v1.0.zip"
mkdir -p snapz && (cd snapz && unzip -qo ../snap.zip); check $? 0 "zip extracts"
diff snap/demo-v1.0/README.md snapz/demo-v1.0/README.md > /dev/null; check $? 0 "zip content matches"

echo "== 9. patch applies with git am; rawdiff with git apply =="
tip=$(cd src && git rev-parse HEAD)
curl -s "$BASE/demo/patch/?id=$tip" -o tip.patch
git init -q -b main am-test && (cd am-test && git config user.email t@t && git config user.name t \
  && $GITC fetch -q "$BASE/demo.git" "$tip" && git checkout -q "$tip~1" \
  && git am -q "$DIR/tip.patch"); check $? 0 "git am applies /patch output"
check "$(cd am-test && git diff --stat HEAD "$tip" | wc -l | tr -d ' ')" "0" "am result tree == original commit"
curl -s "$BASE/demo/rawdiff/?id=$tip" -o tip.diff
(cd am-test && git checkout -q "$tip~1" && git apply --check "$DIR/tip.diff"); check $? 0 "git apply accepts /rawdiff output"

echo "== 10. UI pages =="
for p in "/demo/" "/demo/about/" "/demo/refs/" "/demo/log/" "/demo/log/?qt=author&q=two" "/demo/log/?path=docs/guide.txt" "/demo/tree/" "/demo/tree/lib/math.js" "/demo/blame/lib/math.js" "/demo/commit/" "/demo/diff/" "/demo/stats/" "/demo/stats/?period=w" "/demo/tag/?h=v1.0" "/demo/atom/"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p")
  check "$code" "200" "GET $p"
done
curl -s "$BASE/demo/about/" | grep -q "<h1>demo project</h1>"; check $? 0 "about renders markdown h1"
curl -s "$BASE/demo/about/" | grep -q "<strong>demo</strong>"; check $? 0 "about renders bold"
curl -s "$BASE/demo/log/?qt=author&q=two" | grep -q "add mul function"; check $? 0 "author search finds commit"
n=$(curl -s "$BASE/demo/log/?qt=author&q=two" | grep -c "Dev One"); check "$n" "0" "author search excludes others"
curl -s "$BASE/demo/log/?path=docs/guide.txt" | grep -q "guide update 5"; check $? 0 "path-limited log"
curl -s "$BASE/demo/tree/lib/math.js" | grep -q "hl-k"; check $? 0 "syntax highlighting present"
curl -s "$BASE/demo/blame/lib/math.js" | grep -q "add mul"; fbcode=$?
curl -s "$BASE/demo/blame/lib/math.js" | grep -q "sha1"; check $? 0 "blame page has attributions"
curl -s "$BASE/demo/tag/?h=v1.0" | grep -q "release one point oh"; check $? 0 "tag page shows message"
curl -s "$BASE/demo/atom/" | grep -q "<feed xmlns"; check $? 0 "atom feed"
blob=$(cd src && git rev-parse "HEAD:lib/math.js")
curl -s "$BASE/demo/blob/?id=$blob" | grep -q "function add"; check $? 0 "blob by id"

echo "== 11. config: description/section/owner + registry idle from commit date =="
curl -s -X PUT -u "x:$TOKEN" -d '{"description":"a lovely demo","section":"experiments","owner":"divy"}' "$BASE/demo/config" > /dev/null
# a repo whose only commit is dated 2010: its index "Updated" age must track that
# commit's committer date, not the push time (idle = latest commit time)
curl -s -o /dev/null -X DELETE -u "x:$TOKEN" "$BASE/old-date-repo"
git init -q -b main olddate && (cd olddate && git config user.email o@o && git config user.name o \
  && echo old > o.txt && git add -A \
  && GIT_AUTHOR_DATE="2010-06-15T12:00:00" GIT_COMMITTER_DATE="2010-06-15T12:00:00" git commit -qm "ancient commit" \
  && $GITC push -q "$AUTH_BASE/old-date-repo.git" main)
idx=$(curl -s "$BASE/")
echo "$idx" | grep -q "a lovely demo"; check $? 0 "index shows description"
row=$(echo "$idx" | perl -pe 's{</tr>}{</tr>\n}g' | grep "old-date-repo")
echo "  old-date-repo index row: $row"
echo "$row" | grep -q "year"; check $? 0 "old-date-repo age reflects 2010 commit, not push time"

echo "== 12. private repos =="
git init -q -b main priv && (cd priv && git config user.email t@t && git config user.name t && echo secret > s.txt && git add -A && git commit -qm secret && $GITC push -q "$AUTH_BASE/private-repo.git" main)
curl -s -X PUT -u "x:$TOKEN" -d '{"private":true}' "$BASE/private-repo/config" > /dev/null
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/private-repo/")" "401" "private UI needs auth"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/private-repo.git/info/refs?service=git-upload-pack")" "401" "private clone needs auth"
$GITC clone -q "$BASE/private-repo.git" priv-anon 2>/dev/null; check $? 128 "anonymous clone of private repo fails"
$GITC clone -q "$AUTH_BASE/private-repo.git" priv-auth 2>/dev/null; check $? 0 "authed clone of private repo"
curl -s "$BASE/" | grep -q "private-repo"; check $? 1 "private repo hidden from index"

echo "== 13. delete repo =="
check "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -u "x:$TOKEN" "$BASE/private-repo")" "200" "DELETE repo"
check "$(curl -s -o /dev/null -w '%{http_code}' -u "x:$TOKEN" "$BASE/private-repo/")" "404" "deleted repo is 404"

echo "== 14. auth hard checks =="
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/demo.git/info/refs?service=git-receive-pack")" "401" "push advert needs auth"
check "$(curl -s -o /dev/null -w '%{http_code}' -u "x:wrong" -X POST "$BASE/demo.git/git-receive-pack")" "401" "wrong token rejected"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/nope.git/info/refs?service=git-upload-pack")" "404" "unknown repo 404"

echo
echo "=== RESULT: $PASS passed, $FAIL failed (workdir $DIR) ==="
exit $((FAIL > 0))
