# BEAT LABZ Cloud Studio Security Specification

## 1. Data Invariants
1. All Firestore reads and writes require verified authentication (`request.auth != null && request.auth.token.email_verified == true`), except explicit connection test doc (`test/connection`).
2. User PII (`email`) is strictly isolated in `/users/{userId}/private/info` and readable/writable only when `request.auth.uid == userId`.
3. Every `StudioProject` is owned by `ownerId == request.auth.uid`. `ownerId` and `createdAt` are immutable after creation.
4. Subcollections (`versions`, `collaborators`, `comments`, `audioBackups`) enforce the Master Gate by fetching the parent project document via `get()` on single-document operations and verifying `projectId` matches the path parameter.
5. `allow list` rules strictly filter on `resource.data` (`ownerId == request.auth.uid` or verified `email in resource.data.collaboratorEmails`) with zero `get()` or `exists()` lookups.
6. Large audio files are never stored in Firestore; `audioBackups` stores only validated `objectUrl` metadata pointers (`<= 500` chars).
7. All document IDs match `^[a-zA-Z0-9_\-]+$` and length `<= 128`. All strings and arrays have explicit `.size()` bounds.

## 2. Dirty Dozen Adversarial Payloads
1. Unauthenticated read/write to `/projects/proj_1` -> `PERMISSION_DENIED`.
2. Unverified email (`email_verified: false`) attempting create on `/projects/proj_1` -> `PERMISSION_DENIED`.
3. Identity spoofing: user B creates `/projects/proj_2` with `ownerId: "user_A"` -> `PERMISSION_DENIED`.
4. Shadow field injection: creating `/projects/proj_1` with extra key `isAdmin: true` -> `PERMISSION_DENIED`.
5. Oversized ID poisoning: document ID > 128 chars or containing invalid characters `../` -> `PERMISSION_DENIED`.
6. Oversized string DoS: `title` > 120 chars or `body` > 1000 chars -> `PERMISSION_DENIED`.
7. Timestamp spoofing: `createdAt` or `updatedAt` set to past/future client timestamp instead of `request.time` -> `PERMISSION_DENIED`.
8. Immutable field hijack: updating `ownerId` or `createdAt` on existing project -> `PERMISSION_DENIED`.
9. PII leak: user B attempting `get` on `/users/user_A/private/info` -> `PERMISSION_DENIED`.
10. Unbounded array abuse: `collaboratorEmails` array with > 20 entries -> `PERMISSION_DENIED`.
11. Orphan subcollection write: creating `/projects/nonexistent/versions/v1` -> `PERMISSION_DENIED`.
12. Unscoped list scraping: listing `/projects` without `ownerId == request.auth.uid` or verified collaborator email -> `PERMISSION_DENIED`.
