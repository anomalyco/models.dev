use super::{LookupError, catalog};

#[test]
fn catalog_loads_openai_provider() {
    let catalog = catalog();
    let provider = catalog.provider("openai").expect("openai should exist");
    assert_eq!(provider.id, "openai");
    assert!(provider.model("gpt-5").is_ok());
    assert_eq!(provider.transport(None).family(), Some("openai"));
}

#[test]
fn catalog_loads_anthropic_model() {
    let catalog = catalog();
    let provider = catalog
        .provider("anthropic")
        .expect("anthropic should exist");
    let model = provider
        .model("claude-sonnet-4-0")
        .expect("claude-sonnet-4-0 should exist");
    assert_eq!(model.id, "claude-sonnet-4-0");
}

#[test]
fn catalog_loads_opencode_provider() {
    let catalog = catalog();
    let provider = catalog.provider("opencode").expect("opencode should exist");
    let transport = provider.transport(None);
    assert_eq!(transport.family(), Some("openai"));
    assert_eq!(transport.base_url(), Some("https://opencode.ai/zen/v1"));
}

#[test]
fn unknown_provider_returns_lookup_error() {
    let catalog = catalog();
    let error = catalog
        .provider("does-not-exist")
        .expect_err("unknown provider should fail");
    assert_eq!(
        error,
        LookupError::UnknownProvider {
            provider_id: "does-not-exist".to_owned(),
        }
    );
}
