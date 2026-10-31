package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func file(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "wingman-spec.yaml")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(filepath.Join(t.TempDir(), "missing.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Traceability != "on" || c.Parallel != 3 || c.Visual.PageTimeout != 5 || !c.Visual.ChangedOnly || c.Visual.Present {
		t.Errorf("defaults = %+v", c)
	}
}

func TestLoadLayers(t *testing.T) {
	root := file(t, "traceability: warn\ncommands:\n  test: npm test\n  lint: npm run lint\nvisual:\n  command: npm run dev\n  url: http://127.0.0.1:5173/\n  page_timeout: 8\n  ignore: [a11y:color-contrast]\n")
	repo := file(t, "commands:\n  test: go test ./...\nvisual:\n  command: ./serve\n  url: http://localhost:8080/\nparallel: 2\n")
	c, err := Load(repo, root)
	if err != nil {
		t.Fatal(err)
	}
	if c.Commands.Test != "go test ./..." || c.Commands.Lint != "npm run lint" || c.Traceability != "warn" || c.Parallel != 2 {
		t.Errorf("merged = %+v", c)
	}
	if c.Visual.Command != "./serve" || c.Visual.Port != 8080 || c.Visual.PageTimeout != 8 || len(c.Visual.Ignore) != 1 {
		t.Errorf("visual = %+v", c.Visual)
	}
	if c.Sources["commands.test"] != repo || c.Sources["commands.lint"] != root {
		t.Errorf("sources = %v", c.Sources)
	}
}

func TestLoadVisualOff(t *testing.T) {
	c, err := Load(file(t, "visual: off\n"))
	if err != nil || !c.Visual.Off {
		t.Fatalf("visual off: %v %+v", err, c.Visual)
	}
}

func TestLoadPlaceholders(t *testing.T) {
	c, err := Load(file(t, "commands:\n  test: <fill in>\nvisual:\n  command: <fill in>\n  url: <fill in>\n"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Commands.Test != Placeholder || strings.Join(c.Visual.Placeholders, ",") != "command,url" {
		t.Errorf("got %q %v", c.Commands.Test, c.Visual.Placeholders)
	}
}

func TestLoadErrors(t *testing.T) {
	tests := map[string]string{
		"typo":            "traceabilty: on\n",
		"bad enum":        "traceability: maybe\n",
		"unknown command": "commands:\n  tset: x\n",
		"bad check level": "commands:\n  check_level: often\n",
		"unknown visual":  "visual:\n  comand: x\n",
		"secret in role":  "visual:\n  roles:\n    admin:\n      login: /login\n      password: hunter2\n",
		"role w/o login":  "visual:\n  roles:\n    admin:\n      success: /x\n",
		"bad ignore":      "visual:\n  ignore: [layout:missing-key]\n",
		"zero parallel":   "parallel: 0\n",
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := Load(file(t, body))
			if _, ok := errors.AsType[*Error](err); !ok {
				t.Fatalf("err = %v, want *Error", err)
			}
		})
	}
}

// A limit that is not a number and an ignore list without values are config problems that name the key.
func TestVisualShapeNamesTheKey(t *testing.T) {
	for in, want := range map[string]string{
		"  request_timeout: soon\n": "visual.request_timeout",
		"  port: x\n":               "visual.port",
		"  ignore:\n":               "visual.ignore has no values",
		"  ignore_http:\n":          "visual.ignore_http has no values",
	} {
		var n yaml.Node
		if err := yaml.Unmarshal([]byte("command: x\n"+strings.TrimPrefix(in, "  ")), &n); err != nil {
			t.Fatal(err)
		}
		err := visualNumbers(n.Content[0])
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: err = %v, want %q", in, err, want)
		}
	}
}

// Old configs wrote visual lists as one comma string; duplicate keys and wrong shapes say where and how to fix them.
func TestLoadOldShapes(t *testing.T) {
	c, err := Load(file(t, "visual:\n  ui_files: vue, php ,\n  ignore_http: /img/\n"))
	if err != nil || strings.Join(c.Visual.UIFiles, "|") != "vue|php" || strings.Join(c.Visual.IgnoreHTTP, "|") != "/img/" {
		t.Fatalf("%v %+v", err, c.Visual)
	}
	for body, want := range map[string]string{
		"commands:\n  test: a\n  test: b\n":                  "line 3: commands.test is written twice (first at line 2); keep one and delete the other",
		"visual:\n  roles:\n    a: {login: /l, login: /m}\n": "line 3: visual.roles.a.login is written twice (first at line 3)",
		"rules:\n  tasks: do it\n":                           "line 1: rules: found text \"do it\"; write a list, one \"- value\" per line",
		"commands:\n  test: [a]\n":                           "line 1: commands: found a list; write one value",
		"commands:\n  tset: x\n":                             `line 1: commands: unknown key "tset"`,
	} {
		_, err := Load(file(t, body))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: err = %v, want %q", body, err, want)
		}
	}
}
