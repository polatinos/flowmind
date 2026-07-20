# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HomeyAI — project repository. (Vul hier de projectbeschrijving aan zodra de
eerste code is toegevoegd.)

## Claude Code Integration

Deze repository heeft de Claude Code GitHub Actions integratie geïnstalleerd:

- `.github/workflows/claude.yml` — reageert wanneer je `@claude` noemt in een
  issue, issue-comment, PR-review of PR-review-comment.
- `.github/workflows/claude-code-review.yml` — voert automatisch een code
  review uit op elke geopende of bijgewerkte pull request.

### Vereiste setup (eenmalig)

1. Installeer de **Claude GitHub App** op deze repository:
   https://github.com/apps/claude
2. Voeg een repository secret toe met de naam `ANTHROPIC_API_KEY`
   (Settings → Secrets and variables → Actions → New repository secret).
   Haal de API key op via https://console.anthropic.com/

## Development Guidelines

- Schrijf duidelijke, beschrijvende commit messages.
- Werk in feature branches en open pull requests voor review.
- Noem `@claude` in een issue of PR om Claude Code in te schakelen.
