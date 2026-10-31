// Package cli is the wingman-spec command line. Exit codes are part of the harness contract (see Exit*).
package cli

import (
	_ "embed"

	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Spreizu/wingman-spec/internal/layout"
	"github.com/Spreizu/wingman-spec/internal/verify"
)

// Exit codes (the harness and the extension read them).
const (
	ExitOK        = 0
	ExitFail      = 1
	ExitUsage     = 2
	ExitBlocked   = 3
	ExitExhausted = 4
	ExitReview    = 5
	ExitMode      = 6
	ExitDone      = 10
)

// Version is set at build time with -ldflags "-X github.com/Spreizu/wingman-spec/internal/cli.Version=...".
var Version = "0.12.0-dev"

// exitError carries an exit code; its message (if any) goes to stderr.
type exitError struct {
	code int
	msg  string
}

func (e *exitError) Error() string { return e.msg }

func fail(code int, format string, a ...any) error {
	return &exitError{code, fmt.Sprintf(format, a...)}
}

// app is the state shared by the commands of one run.
type app struct {
	out, errOut io.Writer
	cwd         string
	rootFlag    string
	json        bool
}

func (a *app) root() (*layout.Root, error) {
	override := a.rootFlag
	if override == "" {
		override = os.Getenv("WINGMAN_SPEC_ROOT")
	}
	r, err := layout.Find(a.cwd, override)
	if err != nil {
		return nil, fail(ExitUsage, "%v", err)
	}
	return r, nil
}

// printJSON writes v indented, as the v1 scripts did.
func (a *app) printJSON(v any) error {
	enc := json.NewEncoder(a.out)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

func (a *app) printf(format string, args ...any) { fmt.Fprintf(a.out, format, args...) }

// Run executes the command line and returns the exit code.
func Run(args []string, stdout, stderr io.Writer) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(stderr, "wingman-spec:", err)
		return ExitFail
	}
	return RunIn(cwd, args, stdout, stderr)
}

// RunIn is Run with dir as the current directory.
func RunIn(dir string, args []string, stdout, stderr io.Writer) int {
	a := &app{out: stdout, errOut: stderr, cwd: dir}
	cmd := a.command()
	cmd.SetArgs(args)
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	c, err := cmd.ExecuteC()
	code := a.exitCode(err)
	a.record(c, code)
	return code
}

func (a *app) exitCode(err error) int {
	stderr := a.errOut
	if err == nil {
		return ExitOK
	}
	if ve, ok := errors.AsType[*verify.Exit](err); ok {
		if ve.Msg != "" {
			fmt.Fprintln(stderr, "wingman-spec:", ve.Msg)
		}
		return ve.Code
	}
	if ee, ok := errors.AsType[*exitError](err); ok {
		if ee.msg != "" {
			fmt.Fprintln(stderr, "wingman-spec:", ee.msg)
		}
		return ee.code
	}
	fmt.Fprintln(stderr, "wingman-spec:", err)
	if isUsage(err) {
		return ExitUsage
	}
	return ExitFail
}

func isUsage(err error) bool {
	m := err.Error()
	for _, s := range []string{"unknown command", "unknown flag", "unknown shorthand", "accepts ", "requires at least", "invalid argument", "flag needs an argument"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// reference is `wingman-spec help reference`: the one page the AGENTS block points to.
//
//go:embed reference.md
var reference string

func (a *app) command() *cobra.Command {
	root := &cobra.Command{
		Use:           "wingman-spec",
		Short:         "Spec-driven planning and test-first, script-verified implementation for coding agents",
		Version:       Version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.CompletionOptions.DisableDefaultCmd = true
	root.PersistentFlags().StringVar(&a.rootFlag, "root", "", "specs root directory (default: found from the current directory; env WINGMAN_SPEC_ROOT)")
	root.PersistentFlags().BoolVar(&a.json, "json", false, "print JSON")
	root.AddCommand(
		a.rootCmd(), a.initCmd(), a.updateCmd(), a.newCmd(), a.listCmd(), a.statusCmd(), a.instructionsCmd(), a.validateCmd(),
		a.syncCmd(), a.archiveCmd(), a.importCmd(), a.configCmd(), a.adrsCmd(), a.logCmd(),
	)
	root.AddCommand(a.verifyCmds()...)
	root.AddCommand(a.greenfieldCmds()...)
	root.AddCommand(&cobra.Command{Use: "reference", Short: "Exit codes, checks, run state and configuration in one page", Long: reference})
	return root
}
