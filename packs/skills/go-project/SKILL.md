---
name: go-project
description: Work in a Go module - go build/test/vet, gofmt and golangci-lint, table-driven tests, -race, error wrapping, context and goroutine hygiene.
source: you
uses: 0
category: Coding
triggers: go.mod, go build, go test, go vet, gofmt, goimports, golangci-lint, table-driven test, go test -race, data race, goroutine leak, errors.is, fmt.errorf %w, context.context, nil pointer dereference, go 1.22 loop variable
---

## When
Any Go service, CLI or library. For containers and deploys also read docker-and-deploy.

## Orient
1. code(action="project"); read go.mod (module path, go directive, toolchain line), go.work for multi-module repos, Makefile and .golangci.yml.
2. go version must satisfy the go directive; the toolchain line may auto-download a newer one (that is network, ask).
3. Layout: cmd/<binary>/main.go for executables, internal/ for private packages (not importable outside the module), pkg/ only if the repo already uses it. Tests sit next to code as x_test.go.

## Commands
- go build ./... ; go vet ./... ; go test ./...
- One test: go test ./internal/parse -run '^TestParse$/^empty$' -v (regex; subtest names after /). -count=1 bypasses the test cache.
- Race detector: go test -race ./... on anything with goroutines, maps shared between them, or caches.
- Format: gofmt -l . (empty output = clean) or goimports -w on touched files. Lint: golangci-lint run ./...
- Deps: go mod tidy after adding imports (asks: network). go get pkg@version to change versions.
- SahilBot: code(action="typecheck") runs go vet, code(action="lint") golangci-lint, code(action="run_tests", filter="TestParse").

## Idioms
- Errors are values: check every one, return early. Wrap with context: fmt.Errorf("load %s: %w", path, err). Inspect with errors.Is(err, fs.ErrNotExist) and errors.As(err, &target); never compare err.Error() strings.
- Sentinel errors (var ErrNotFound = errors.New("not found")) or typed errors for callers that branch.
- context.Context is the first parameter of anything that blocks or does I/O; pass it down, never store it in a struct; respect ctx.Done(); always defer cancel().
- Interfaces small (one or two methods) and defined where they are consumed; return concrete types.
- Zero values useful; constructors only when invariants need them.
- defer for cleanup (Close, Unlock), but not inside long loops.

## Goroutines
- Every goroutine needs a way to stop: context cancellation, a closed channel or a WaitGroup. A blocked send on an unbuffered channel nobody reads is a leak.
- Use errgroup.WithContext for fan-out with error propagation; sync.Mutex for shared maps (maps are not safe for concurrent writes).
- Only the sender closes a channel.

## Pitfalls
- Nil interface: a nil *MyErr returned as error is non-nil. Return a literal nil.
- Loop variables: since Go 1.22 each iteration gets a fresh variable, so closures and goroutines are safe; with go < 1.22 in go.mod, copy (v := v) first.
- Appending to a slice shared with a caller can overwrite its backing array; copy when needed.
- Ranging over a map gives random order; sort keys for stable output and tests.
- Nil map writes panic; make it first. Nil pointer dereference usually means an unchecked error.
- time.After in a loop allocates timers; use a Ticker or Timer with Reset.
- Unused imports and variables fail the build; don't leave _ = x hacks.

## Testing
Table-driven tests with t.Run(tc.name, ...), t.Helper in helpers, t.Cleanup and t.TempDir for setup, t.Parallel where independent. httptest.NewServer for HTTP. Compare structs with cmp.Diff or reflect.DeepEqual.

## Verify
gofmt -l . empty, go vet and golangci-lint clean, go test -race on touched packages then go test ./... green.

## Example
```go
func TestParse(t *testing.T) {
	tests := []struct{ name, in string; want int; wantErr bool }{
		{"simple", "42", 42, false},
		{"empty", "", 0, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Parse(tc.in)
			if (err != nil) != tc.wantErr || got != tc.want {
				t.Fatalf("Parse(%q) = %d, %v; want %d", tc.in, got, err, tc.want)
			}
		})
	}
}
```
