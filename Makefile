.PHONY: check lint fmt

check:
	cargo check && cargo check --tests

lint:
	cargo clippy && cargo clippy --tests

fmt:
	cargo fmt --all
