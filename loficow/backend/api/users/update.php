<?php
$user = requireAuth();
$body = json_decode(file_get_contents('php://input'), true) ?? [];

$allowed = ['display_name','bio','website','location','avatar_url','cover_url'];
$updates = [];
$params  = [];

foreach ($allowed as $field) {
    if (isset($body[$field])) {
        $updates[] = "$field = ?";
        $params[]  = trim($body[$field]);
    }
}

if (empty($updates)) error('No fields to update');

$params[] = $user['id'];
$db = getDB();
$db->prepare('UPDATE users SET ' . implode(', ', $updates) . ' WHERE id = ?')->execute($params);

$updated = $db->query("
    SELECT id, username, display_name, account_type, bio, avatar_url, cover_url,
           website, location, verified, followers_count, following_count, tracks_count
    FROM users WHERE id = {$user['id']}
")->fetch();

json(['user' => $updated]);
