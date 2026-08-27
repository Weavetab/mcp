---
title: "Automation Recipes"
description: "Step-by-step recipes for common browser automation challenges."
product: mcp
section: skills-ecosystem
icon: BookOpenCheck
slug: skills-recipes
---

# Automation Skills Recipes

## Recipe 1: Handling Dynamic Cookie Consent Overlays

```markdown
1. Run browser_find({ query: "Accept all cookies" })
2. If found, call browser_click({ label: "Accept all" })
3. Wait for stability: browser_wait({ for: "stable", timeout: 2000 })
4. Read page with delta: browser_map({ delta: true, prune: true })
```

---

## Recipe 2: Autonomous Form Completion

```markdown
1. Map the form: browser_map({ scope: "form", query: "input" })
2. Batch fill fields in one round-trip:
   browser_fill({
     fields: [
       { ref: "w:12", value: "alex@company.com" },
       { ref: "w:14", value: "United States" }
     ],
     submit: "w:16"
   })
3. Wait for submission: browser_wait({ for: "network" })
```
