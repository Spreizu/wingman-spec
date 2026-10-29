// Unit checks of quality.resolveTaskLines (run by tests/task-lines.sh): node unit.cjs <quality.cjs> <this dir> <scratch dir>
const Q=require(process.argv[2]); const fs=require("fs"); const dir=process.argv[3];
const j=JSON.parse(fs.readFileSync(dir+"/apply.json","utf8")); const f=dir+"/tasks.md";
const r=Q.resolveTaskLines(j.tasks,[f]); console.log(r.map((x)=>x.line).join(","), r.every((x)=>x.file===f));
// the same tasks in two files, in file order, and a description that exists in both
const a=process.argv[4]+"/a.md", b=process.argv[4]+"/b.md"; fs.mkdirSync(process.argv[4],{recursive:true});
fs.writeFileSync(a,"- [x] Add a box\n- [ ] Show a hint\n"); fs.writeFileSync(b,"- [ ] Show a hint\n- [ ] Say nothing found\n");
const two=Q.resolveTaskLines([{description:"Add a box",done:true},{description:"Show a hint",done:false},{description:"Show a hint",done:false},{description:"Say nothing found",done:false}],[a,b]);
console.log(two.map((x)=>require("path").basename(x.file)+":"+x.line).join(","));
// sourcePath restricts the search; a given line is trusted
const show=(r)=>r.map((x)=>require("path").basename(x.file)+":"+x.line).join(",");
console.log(show(Q.resolveTaskLines([{description:"Show a hint",done:false,sourcePath:b}],[a,b])), show(Q.resolveTaskLines([{description:"x",done:false,line:7,sourcePath:a}],[a])));
// label fallback and whitespace
fs.writeFileSync(a,"- [ ]   1.4   Spaced    out text\n"); console.log(Q.resolveTaskLines([{description:"1.4 Spaced out text",done:false},],[a])[0].line, Q.resolveTaskLines([{description:"Spaced out text",done:false}],[a])[0].line, Q.resolveTaskLines([{description:"1.4 Reworded",done:false}],[a])[0].line);
try { Q.resolveTaskLines([{description:"Nothing like it",done:false}],[a]); console.log("no error"); } catch (e) { console.log("refused:", /cannot find the checkbox of task "Nothing like it"/.test(e.message)); }
