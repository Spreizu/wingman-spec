package verify

import (
	"io"
	"os"
	"path/filepath"

	"github.com/Spreizu/wingman-spec/internal/report"
	"github.com/Spreizu/wingman-spec/internal/trace"
)

func (e *Env) writeReport(title string, fs []report.Finding, json *Obj, fail bool) error {
	switch e.O.Report {
	case "", "json":
		if json != nil {
			e.print(json)
		}
	case "sarif":
		if err := report.WriteSARIF(e.Out, "wingman-spec", fs); err != nil {
			return err
		}
	case "markdown":
		if _, err := io.WriteString(e.Out, report.Markdown(title, fs, nil)); err != nil {
			return err
		}
	case "junit":
		if err := report.JUnit(e.Out, title, fs); err != nil {
			return err
		}
	default:
		return die(Usage, "--format must be json|sarif|markdown|junit")
	}
	if fail {
		return quit(Fail)
	}
	return nil
}

func findingsOfProblems(fs []Finding) []report.Finding {
	out := make([]report.Finding, len(fs))
	for i, f := range fs {
		out[i] = report.Finding{Source: f.Source, Code: f.Code, Severity: f.Severity, Message: f.Message, File: f.File, Line: f.Line, Col: f.Col, Key: f.Key, Hint: f.Hint}
	}
	return out
}

func (e *Env) saySkipped() {
	n := len(e.index().Skipped)
	if n == 0 {
		return
	}
	e.say("skipped %d unreadable file(s)", n)
}

func (e *Env) writeTraceArtifact(dir string) {
	tr := e.tr()
	r := tr.AnchorLint(dir)
	ix := trace.AnchorIndex(r.Eff, r.Facts)
	b, err := marshal(O("schema_version", report.SchemaVersion, "change", e.O.Change, "index", ix, "problems", r.Problems, "skipped", e.skippedObj()))
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "trace.json"), b, 0o644)
}
