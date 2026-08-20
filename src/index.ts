// Deploy entry for the stock dgit Worker: default options (token auth, no
// push hook). To build your own, `import { createDurableGit } from
// "durable-git"` in your Worker and pass authorize/onPush — see the README.
import { createDurableGit } from "./mod";

export { RepoCell, Registry } from "./mod";

export default createDurableGit();
