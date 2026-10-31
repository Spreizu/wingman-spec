// Command wingman-spec is the Wingman Spec CLI.
package main

import (
	"os"

	"github.com/Spreizu/wingman-spec/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr))
}
