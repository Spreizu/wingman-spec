package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Spreizu/wingman-spec/internal/tasks"
	"github.com/Spreizu/wingman-spec/internal/timeline"
)

// progress.md is the change's work log: next and finish hand it to the implementer, the review proof reads its
// `Review fix:` lines and the anchor guard its `Reviewed anchors:` lines. Agents write it only through `progress`,
// which checks the entry, appends one bullet under the task's heading and records a progress event in the timeline.

var (
	slugRE   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	anchorRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$`)
	headRE   = regexp.MustCompile(`(?m)^## (.*)$`)
)

// oneLine is s trimmed, or an error when it is empty or spans lines.
func oneLine(flag, s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || strings.ContainsAny(s, "\r\n") {
		return "", die(Usage, "%s needs one line of text", flag)
	}
	return s, nil
}

// Progress appends one entry to progress.md: a note, a review fix or a reviewed anchor.
func (e *Env) Progress() error {
	changeDir, err := e.changeDir()
	if err != nil {
		return err
	}
	o := e.O
	note, err := oneLine("--note", o.Note)
	if err != nil {
		return err
	}
	if o.ReviewFix != "" && o.Anchor != "" {
		return die(Usage, "pass --review-fix or --reviewed-anchor, not both")
	}
	if o.Untestable != "" && o.ReviewFix == "" {
		return die(Usage, "--untestable goes with --review-fix")
	}
	if o.Status != "" && (o.ReviewFix != "" || o.Anchor != "" || !slices.Contains([]string{"done", "partial", "blocked"}, o.Status)) {
		return die(Usage, "--status is done|partial|blocked, on a plain note")
	}
	heading := "Change"
	var task *tasks.Task
	if o.Task != "" {
		refs, _, err := loadTasks(changeDir)
		if err != nil {
			return err
		}
		var labels []string
		for _, r := range refs {
			labels = append(labels, r.T.Label)
			if r.T.Label == o.Task {
				task = r.T
			}
		}
		if task == nil {
			return die(Usage, "task %s is not in tasks.md (tasks: %s)", o.Task, strings.Join(labels, ", "))
		}
		heading = describe(task)
	}
	f := filepath.Join(changeDir, "progress.md")
	old := readText(f)
	line, summary := note, note
	switch {
	case o.ReviewFix != "":
		if !slugRE.MatchString(o.ReviewFix) {
			return die(Usage, "--review-fix needs a slug: lowercase letters, digits and -")
		}
		if task == nil || !tasks.IsReview(task.Label, task.Title) {
			return die(Usage, "--review-fix needs --task <the review task>")
		}
		line = "Review fix: " + o.ReviewFix + " - " + note
		summary = "Review fix " + o.ReviewFix + ": " + note
		if o.Untestable != "" {
			u, err := oneLine("--untestable", o.Untestable)
			if err != nil {
				return err
			}
			line += " - untestable: " + u
			summary += " (untestable: " + u + ")"
		}
	case o.Anchor != "":
		if !anchorRE.MatchString(o.Anchor) {
			return die(Usage, "--reviewed-anchor needs <capability>/<requirement-slug>, as the anchor guard names it")
		}
		line = "Reviewed anchors: " + o.Anchor + " - " + note
		summary = "Reviewed anchor " + o.Anchor + ": " + note
	case o.Status != "":
		line = note + " (" + o.Status + ")"
		summary = line
	}
	if o.ReviewFix != "" { // a slug recorded again replaces its line (a test found, or untestable after all)
		re := regexp.MustCompile(`(?m)^[ \t]*(?:[-*][ \t]+)?Review fix:[ \t]*` + o.ReviewFix + `(?:[ \t].*)?$`)
		if re.MatchString(old) {
			return e.progressWrite(f, re.ReplaceAllLiteralString(old, "- "+line), os.O_TRUNC, line, summary+" (replaces the earlier entry)", task)
		}
	}
	var b strings.Builder
	if old == "" {
		fmt.Fprintf(&b, "# Progress: %s\n", o.Change)
	}
	if hs := headRE.FindAllStringSubmatch(old, -1); len(hs) == 0 || hs[len(hs)-1][1] != heading {
		b.WriteString("\n## " + heading + "\n\n")
	} else if !strings.HasSuffix(old, "\n") {
		b.WriteString("\n")
	}
	b.WriteString("- " + line + "\n")
	return e.progressWrite(f, b.String(), os.O_APPEND, line, summary, task)
}

// progressWrite appends text to progress.md (mode os.O_APPEND) or replaces it (os.O_TRUNC), then records the event.
func (e *Env) progressWrite(f, text string, mode int, line, summary string, task *tasks.Task) error {
	fh, err := os.OpenFile(f, mode|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		_, err = fh.WriteString(text)
		if cerr := fh.Close(); err == nil {
			err = cerr
		}
	}
	if err != nil {
		return die(Fail, "cannot write progress.md: %v", err)
	}
	ev := timeline.Event{Event: "progress", Summary: summary}
	if task != nil {
		ev.Task = task.Label
	}
	e.tl(ev)
	e.print(O("ok", true, "file", rel(e.code, f), "line", line))
	return nil
}
