<?php
$user = requireAuth();
$db = getDB();
$db->prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?')->execute([$user['id']]);
json(['message' => 'Marked as read']);
