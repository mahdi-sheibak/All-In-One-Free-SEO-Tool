## Purpose

Lets users register any number of OpenAI-compatible chat-completion endpoints (local servers, LAN gateways, niche clouds) as first-class AI providers alongside the built-in catalog, with encrypted key storage, model selection, testing, and full participation in existing AI features.

## ADDED Requirements

### Requirement: Add a custom provider

The system SHALL let the user create a custom provider by supplying a display label, a base URL, an optional API key, and a free-text model id. The base URL MUST use the `http` or `https` scheme; other schemes SHALL be rejected. The label, base URL, and model id are REQUIRED; the API key is optional.

#### Scenario: Create with valid fields

- **WHEN** the user submits a label, `http://localhost:1234/v1` base URL, optional key, and model `qwen2.5-32b`
- **THEN** the system stores the provider and shows it in the settings provider list

#### Scenario: Reject non-http scheme

- **WHEN** the user submits a base URL with scheme `file` or `ftp`
- **THEN** the system rejects the entry with a validation error and stores nothing

#### Scenario: Optional API key

- **WHEN** the user saves a custom provider with a blank API key
- **THEN** the system stores the provider and later calls to it omit the `Authorization` header

### Requirement: Manage multiple custom providers

The system SHALL support an arbitrary number of custom providers, each editable and deletable independently. Deleting a custom provider SHALL NOT affect other providers. If the deleted provider was active, the system SHALL fall back to the default active provider.

#### Scenario: Edit a provider

- **WHEN** the user changes the base URL or model of an existing custom provider
- **THEN** subsequent AI calls use the new values

#### Scenario: Delete the active custom provider

- **WHEN** the user deletes a custom provider that is currently the active provider
- **THEN** the system removes it and resets the active provider to the default

### Requirement: API key encryption at rest

The system SHALL encrypt custom provider API keys with the same key-encryption path used for built-in provider keys before storing them. Keys SHALL NOT be returned in plaintext to the client after save.

#### Scenario: Key stored encrypted

- **WHEN** a custom provider is saved with an API key
- **THEN** the stored settings row contains the key only in encrypted form and client-facing reads do not include the plaintext key

### Requirement: Custom providers are selectable and callable

A custom provider SHALL appear in the configured-providers list once saved, SHALL be settable as the active provider, and AI calls routed to it SHALL send an OpenAI chat-completions request to `<baseUrl>/chat/completions` with the stored model id. The `Authorization: Bearer <key>` header SHALL be sent when a key is stored and omitted when not.

#### Scenario: Active provider call

- **WHEN** the active provider is a custom provider with base URL `https://gw.example.com/v1`, key `sk-x`, model `m-1` and an AI feature runs
- **THEN** the system POSTs to `https://gw.example.com/v1/chat/completions` with model `m-1` and the Bearer header

#### Scenario: Set active

- **WHEN** the user activates a custom provider
- **THEN** subsequent AI calls dispatch to it

### Requirement: Model id entry for custom providers

For a custom provider, the model selection UI SHALL accept a free-text model id instead of a preset dropdown. Changing the model SHALL persist with the provider.

#### Scenario: Model text input

- **WHEN** the active provider is a custom provider
- **THEN** the model picker shows a text input seeded with the stored model id

### Requirement: Test a custom provider

The provider test action SHALL support custom providers, probing `<baseUrl>/chat/completions` with the stored model and key, and report success or failure.

#### Scenario: Test passes

- **WHEN** the user runs the test action on a custom provider pointing at a reachable endpoint
- **THEN** the system reports test success with the provider label

#### Scenario: Test fails

- **WHEN** the user runs the test action on a custom provider pointing at an unreachable endpoint
- **THEN** the system reports test failure with a network error message

### Requirement: Local and private endpoints allowed

Custom provider base URLs SHALL be allowed to reference localhost and private LAN addresses. Custom endpoints SHALL NOT be filtered by the URL guard used for scraped user input. This matches the existing trust class of the user-supplied Ollama URL: admin-supplied configuration, not untrusted input.

#### Scenario: Local LM Studio endpoint

- **WHEN** a custom provider base URL is `http://localhost:1234/v1`
- **THEN** AI calls to it are permitted and not blocked by the URL guard

### Requirement: Custom providers in existing AI features

Custom providers SHALL participate in features that enumerate configured providers: AI visibility fanout (with memory-based grounding), vision analysis (OpenAI image format), and the assistant chat. Usage logs SHALL record the custom provider id in the provider column, and cost estimation SHALL apply its existing fallback rate for unknown model ids.

#### Scenario: Visibility fanout

- **WHEN** AI visibility analysis runs and a custom provider is configured with a key or keyless local endpoint
- **THEN** the custom provider receives a fanout call with memory-based grounding

#### Scenario: Usage log attribution

- **WHEN** an AI call is served by a custom provider
- **THEN** the usage log row records the custom provider id

### Requirement: Built-in catalog unaffected

Adding, editing, or deleting custom providers SHALL NOT alter the built-in provider catalog or its behavior. The two latent allowlist gaps in built-in provider activation (mistral, deepseek, cerebras, together, github) SHALL be closed so all built-in providers can be set active and used in assistant chat.

#### Scenario: All built-in providers activatable

- **WHEN** the user sets any built-in catalog provider as active
- **THEN** activation succeeds
