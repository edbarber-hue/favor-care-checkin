# Favor Kids Care

A simple site for Favor Kids leaders to check in on their people every two weeks.

- Each leader signs in with their own email and password.
- Everyone on the team is shown as **Fit** (checked on in the last 4 weeks), **Check soon** (5–6 weeks) or **Overdue** (7+ weeks or never).
- Care notes are private: only the leader who wrote a note can read it.
- Anyone can raise a concern, and it shows at the top for everyone until someone marks it handled.

The site is plain HTML and JavaScript hosted on GitHub Pages. Logins and data live in a free Firebase project.

## One-time setup (about 10 minutes)

### 1. Create the Firebase project
1. Go to https://console.firebase.google.com and sign in with a Google account.
2. **Create a project** → name it `favor-care-checkin` → you can turn off Google Analytics → **Create**.

### 2. Turn on email and password logins
1. In the left menu: **Build → Authentication → Get started**.
2. **Sign-in method → Email/Password → Enable → Save**.
3. **Settings → Authorized domains → Add domain** → add `edbarber-hue.github.io`.

### 3. Create the database
1. **Build → Firestore Database → Create database**.
2. Pick a location near you (for example `asia-southeast1` Singapore) → **Start in production mode** → **Create**.
3. Open the **Rules** tab, delete what's there, paste everything from `firestore.rules` in this repo, and **Publish**.

### 4. Make yourself the first admin
1. In Firestore, open the **Data** tab → **Start collection** → Collection ID: `allowlist`.
2. Document ID: **your email in lowercase** (for example `ed@example.com`).
3. Add three fields (all type *string*):
   - `name` = `Ed`
   - `dept` = `All`
   - `role` = `admin`
4. **Save**.

### 5. Connect the site
1. Click the gear icon → **Project settings** → scroll to **Your apps** → click the **</>** (Web) icon.
2. Nickname `care-site` → **Register app** (skip Firebase Hosting).
3. Copy the `firebaseConfig = { ... }` block it shows.
4. Paste it into `config.js` in this repo so it reads `window.FIREBASE_CONFIG = { apiKey: "...", ... };` (or send it to Claude to do it).

These values are safe to be public. The Firestore rules decide who can read and write.

### 6. First sign-in
1. Open the site → **First time? Create an account** with your email → tap the link in the verification email → **Continue**.
2. **Admin → Settings → Set up departments**.
3. **Admin → People → Import a list** and paste the roster.
4. **Admin → Leaders** and add each department head's email. They can then open the site and create their own account.

## Files
- `index.html`, `style.css`, `app.js`: the site
- `config.js`: Firebase connection settings
- `firestore.rules`: who can see and change what (paste into Firebase)
