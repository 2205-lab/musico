<?php
$db = getDB();
$stmt = $db->query('SELECT * FROM channels ORDER BY is_official DESC, members_count DESC');
json(['channels' => $stmt->fetchAll()]);
