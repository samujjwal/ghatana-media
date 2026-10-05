# Quarantined root Media CI candidate

The GitHub and Gitea workflow candidates are preserved from the Ghatana source
repository for owner review. The GitHub workflow still targets the retired
`products/audio-video` layout and contains deployment commands. Gitea CI still
has unresolved Gradle task coordinates and image-publishing steps; Gitea CD
contains staging and production deployment steps. They are intentionally kept
outside active workflow discovery and must not be activated as copied.

Before these workflows can move into active CI/CD, their paths and tasks must
match this repository, external Data Cloud inputs must be declared, and the
Media CI/operations owners must review evidence, publishing, and deployment
steps. The current migration does not authorize publishing, deployment, or
activation.
