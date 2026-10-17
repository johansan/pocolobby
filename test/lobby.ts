/** The lobby the tests act in. A new broker has none until its owner creates one (0.8.3). */
export const LOBBY = 'my-team';

/** Creates a lobby on a running broker through the owner API, as `pocolobby lobby create` does. */
export async function createLobby(url: string, ownerToken: string, lobby = LOBBY): Promise<void> {
  const response = await fetch(`${url}/v1/admin/lobbies`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ lobby_id: lobby }),
  });
  if (response.status !== 201)
    throw new Error(`Creating lobby ${lobby} failed: ${response.status} ${await response.text()}`);
}
