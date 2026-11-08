- Aim for stable and simple function signatures. If you find yourself sneaking in extra parameters that change the shape of the return value, consider refactoring into multiple methods.

```typescript
// 👎 BAD
function getUser(userId: string, includeDetails?: boolean): Partial<IUserWithDetails> {
  const user = db.getUserById(userId);
  if (includeDetails) {
    user.details = db.getUserDetails(userId);
  }
  return user;
}

// 👍 GOOD
function getUser(userId: string): IUser {
  return db.getUserById(userId);
}

function getUserWithDetails(userId: string): IUserWithDetails {
  const user = db.getUserById(userId);
  user.details = db.getUserDetails(userId);
  return user;
}
```
