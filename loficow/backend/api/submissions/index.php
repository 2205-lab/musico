<?php
$user = requireAuth();
$db = getDB();

$role = $_GET['role'] ?? 'artist'; // 'artist' or 'label'

if ($role === 'label') {
    if (!in_array($user['account_type'], ['label','both'])) error('Label account required', 403);
    $stmt = $db->prepare("
        SELECT s.*, a.username as artist_username, a.display_name as artist_name, a.avatar_url as artist_avatar
        FROM submissions s JOIN users a ON a.id = s.artist_id
        WHERE s.label_id = ?
        ORDER BY s.created_at DESC LIMIT 50
    ");
    $stmt->execute([$user['id']]);
} else {
    $stmt = $db->prepare("
        SELECT s.*, l.username as label_username, l.display_name as label_name, l.avatar_url as label_avatar
        FROM submissions s JOIN users l ON l.id = s.label_id
        WHERE s.artist_id = ?
        ORDER BY s.created_at DESC LIMIT 50
    ");
    $stmt->execute([$user['id']]);
}

json(['submissions' => $stmt->fetchAll()]);
