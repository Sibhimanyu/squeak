# People data in tables, content sealed, notices only to who watches

The cloud keeps two kinds of data apart. Who is in a Pond (accounts, names, devices, memberships, invites) lives in
server-readable Catalyst Data Store tables, so the server can enforce removal at once, keep one invite record everyone
draws, and serve names from sign-in. What people and Ducks say stays sealed by devices in the NoSQL table, and the server
only stores and orders it with a per-Pond sequence number. Changes reach devices through one relay on AppSail that sends
each notice only to the connections watching that Pond, with Data Streams used only between AppSail's own instances.

We moved membership out of owner-signed sealed documents because then only the Owner's Mac could change it, so leaving,
joining and new devices waited on a laptop. Signed member documents still say who holds the key. We stopped sending every
notice to every device on one shared Data Streams channel because traffic then grows with the square of the number of
users and every device re-reads lists on noise. Data Streams cannot carry targeted notices itself: its channels are made
by hand in the console and resuming after a drop repeats messages.

Research spike on live connections and the people-table limits: [cloud-spike-2026-11](../cloud-spike-2026-11.md).
