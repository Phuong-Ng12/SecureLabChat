const ROOMS = ['#general', '#announcements'];

const ROLES = ['Admin', 'Manager', 'Supervisor', 'Staff'];

// A department channel has primary key which is the department id, so two similar names can
// never clash. The visible name comes from the departments table.
function departmentRoom(departmentId) {
    return `#dept-${departmentId}`;
}

// Server-side posting rules (the browser check is only cosmetic)
function canPost(role, room, departmentId) {
    if (room === '#announcements') return role === 'Manager' || role === 'Admin';
    if (room === '#general') return ['Manager', 'Admin', 'Supervisor'].includes(role);

    // department channel: only a Supervisor, and only in their own department
    if (departmentId != null && room === departmentRoom(departmentId)) {
        return role === 'Supervisor';
    }
    return false;
}

module.exports = { ROOMS, ROLES, departmentRoom, canPost };