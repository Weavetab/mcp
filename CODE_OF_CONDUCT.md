# Contributor Covenant Code of Conduct

> **Version:** 2.5.0 (Beta) | **Last Updated:** July 6, 2026

---

## Our Pledge

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone, regardless of age, body size, visible or invisible disability, ethnicity, sex characteristics, gender identity and expression, level of experience, education, socio-economic status, nationality, personal appearance, race, religion, or sexual identity and orientation.

We pledge to act and interact in ways that contribute to an open, welcoming, diverse, inclusive, and healthy community.

---

## Our Standards

### Positive Behavior

Examples of behavior that contributes to a positive environment for our community include:

- **Demonstrating empathy and kindness** toward other people
- **Being respectful** of differing opinions, viewpoints, and experiences
- **Giving and gracefully accepting constructive feedback**
- **Accepting responsibility** and apologizing to those affected by our mistakes, learning from the experience
- **Focusing on what is best** not just for us as individuals, but for the overall community

### Unacceptable Behavior

Examples of unacceptable behavior include:

- **The use of sexualized language or imagery**, and sexual attention or advances of any kind
- **Trolling, insulting, or derogatory comments**, and personal or political attacks
- **Public or private harassment**
- **Publishing others' private information**, such as a physical or email address, without explicit permission
- **Other conduct** which could reasonably be considered inappropriate in a professional setting

---

## Enforcement Responsibilities

Community leaders are responsible for clarifying and enforcing our standards of acceptable behavior and will take appropriate and fair corrective action in response to any behavior that they deem inappropriate, threatening, offensive, or harmful.

Community leaders have the right and responsibility to remove, edit, or reject comments, commits, code, wiki edits, issues, and other contributions that are not aligned with this Code of Conduct, and will communicate reasons for moderation decisions when appropriate.

---

## Scope

This Code of Conduct applies within all community spaces, and also applies when an individual is officially representing the community in public spaces. Examples of representing our community include using an official e-mail address, posting via an official social media account, or acting as an appointed representative at an online or offline event.

---

## Enforcement

### Reporting Instances

Instances of abusive, harassing, or otherwise unacceptable behavior may be reported to the community leaders responsible for enforcement at:

- **Email:** conduct@Weavetab.dev
- **GitHub:** Use the private vulnerability reporting feature on the repository

All complaints will be reviewed and investigated promptly and fairly.

### Investigation Process

1. **Receipt** — Acknowledgment within 48 hours
2. **Assessment** — Initial review and severity classification within 7 days
3. **Action** — Appropriate corrective action within 30 days

### Consequences

Community leaders may take any action they deem appropriate, including warning the offender, temporary or permanent banning from the community, and contacting law enforcement if necessary.

---

## Attribution

This Code of Conduct is adapted from the [Contributor Covenant][homepage], version 2.1, available at [https://www.contributor-covenant.org/version/2/1/code_of_conduct.html][v2.1].

Community Impact Guidelines were inspired by [Mozilla's code of conduct enforcement ladder][mozilla].

[homepage]: https://www.contributor-covenant.org
[v2.1]: https://www.contributor-covenant.org/version/2/1/code_of_conduct.html
[mozilla]: https://github.com/mozilla/diversity

---

## Additional Guidelines for Weavetab

### Security-Related Contributions

Given Weavetab's focus on enterprise security and browser automation:

- **Security disclosures** must follow the reporting process outlined in [SECURITY.md](SECURITY.md)
- **Credential handling** code must adhere to Blind Injection principles
- **Domain policy** contributions must not weaken default security settings
- **RBAC implementations** must maintain the principle of least privilege

### AI Agent Safety

When contributing to AI agent capabilities:

- **Loop detection** mechanisms must not be weakened
- **Rate limiting** must remain in place for all tool executions
- **Domain blacklists** should not be removed without security review
- **Blind Injection** protections must be maintained for all credential handling

### Performance Standards

Weavetab maintains strict performance targets:

- **Tool latency** should remain under 10ms for CDP operations
- **Memory footprint** should not exceed 100MB per session
- **Token efficiency** improvements are encouraged but must not compromise accuracy
- **Cache hit rates** should be monitored and optimized

### Testing Requirements

All contributions must include:

- **Unit tests** for new functionality
- **Integration tests** for tool interactions
- **Security tests** for any authentication/authorization changes
- **Performance benchmarks** for any optimization work

---

## Contact Information

For questions about this Code of Conduct or its enforcement:

- **Project Maintainer:** fy2ne
- **Email:** conduct@Weavetab.dev
- **GitHub:** https://github.com/weavetab/mcp

---

## License

This project is licensed under the AGPL-3.0 license. By contributing to Weavetab, you agree that your contributions will be licensed under the same license.
